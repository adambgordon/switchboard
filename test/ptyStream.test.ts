import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtySnapshot } from '../src/shared/types'

type Emit = (id: string, data: string) => void
type SnapshotRequest = (requestId: string, ptyId: string) => void
type SnapshotStage = (ptyId: string, snapshot: PtySnapshot) => void

const snap = (data: string): PtySnapshot => ({
  data,
  cols: 100,
  rows: 40,
  viewportFromBottom: 3
})

async function freshStream() {
  vi.resetModules()
  let emit: Emit = () => {}
  let request: SnapshotRequest = () => {}
  let stage: SnapshotStage = () => {}
  const pauses: Array<{ id: string; paused: boolean }> = []
  const replies: Array<{ requestId: string; ptyId: string; snapshot: PtySnapshot | null }> = []
  let dataSubscriptions = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onPtyData: (cb: Emit) => {
        dataSubscriptions += 1
        emit = cb
        return () => {}
      },
      setPtyOutputPaused: (id: string, paused: boolean) => pauses.push({ id, paused }),
      onPtySnapshotRequest: (cb: SnapshotRequest) => {
        request = cb
        return () => {}
      },
      replyPtySnapshot: (requestId: string, ptyId: string, snapshot: PtySnapshot | null) =>
        replies.push({ requestId, ptyId, snapshot }),
      onPtySnapshotStage: (cb: SnapshotStage) => {
        stage = cb
        return () => {}
      }
    }
  }
  const mod = await import('../src/renderer/lib/ptyStream')
  return {
    ...mod,
    emit: (id: string, data: string) => emit(id, data),
    request: (requestId: string, ptyId: string) => request(requestId, ptyId),
    stage: (ptyId: string, snapshot: PtySnapshot) => stage(ptyId, snapshot),
    pauses,
    replies,
    dataSubscriptions: () => dataSubscriptions
  }
}

beforeEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('ptyStream', () => {
  it('subscribes once and delivers buffered output in order', async () => {
    const s = await freshStream()
    s.initPtyStream()
    s.initPtyStream()
    s.emit('a', 'one')
    s.emit('a', 'two')
    const got: string[] = []
    s.attachPty('a', (data, done) => {
      got.push(data)
      done()
    }, () => snap('state'))
    expect(s.dataSubscriptions()).toBe(1)
    expect(got).toEqual(['one', 'two'])
  })

  it('does not serialize on detach now that pane moves preserve the xterm', async () => {
    const s = await freshStream()
    const first: string[] = []
    let snapshots = 0
    const detach = s.attachPty('a', (data, done) => {
      first.push(data)
      done()
    }, () => {
      snapshots += 1
      return snap('serialized-state')
    })
    s.emit('a', 'live-output')
    detach()

    const second: string[] = []
    let restored: PtySnapshot | null = null
    s.attachPty('a', (data, done) => {
      second.push(data)
      done()
    }, () => snap('next-state'), (value) => {
      restored = value
    })
    expect(first).toEqual(['live-output'])
    expect(second).toEqual([])
    expect(restored).toBeNull()
    expect(snapshots).toBe(0)
  })

  it('replays unacknowledged output after a detach exactly once', async () => {
    const s = await freshStream()
    const oldAcks: Array<() => void> = []
    const detach = s.attachPty('a', (_data, done) => oldAcks.push(done), () => snap('base'))
    s.emit('a', 'tail-1')
    s.emit('a', 'tail-2')
    detach()

    const got: string[] = []
    s.attachPty('a', (data, done) => {
      got.push(data)
      done()
    }, () => snap('next'))
    expect(got).toEqual(['tail-1', 'tail-2'])
    oldAcks.forEach((ack) => ack())
    expect(got).toEqual(['tail-1', 'tail-2'])
  })

  it('waits for xterm write acknowledgements before answering a snapshot request', async () => {
    const s = await freshStream()
    let acknowledge = (): void => {}
    s.attachPty('a', (_data, done) => {
      acknowledge = done
    }, () => snap('drained'))
    s.emit('a', 'pending')
    s.request('request-1', 'a')
    await Promise.resolve()
    expect(s.replies).toEqual([])
    acknowledge()
    await Promise.resolve()
    expect(s.replies).toEqual([
      { requestId: 'request-1', ptyId: 'a', snapshot: snap('drained') }
    ])
  })

  it('applies backpressure at the high-water mark and releases below the low-water mark', async () => {
    const s = await freshStream()
    const acknowledgements: Array<() => void> = []
    s.attachPty('a', (_data, done) => acknowledgements.push(done), () => snap('state'))
    const chunk = 'x'.repeat(100 * 1024)
    s.emit('a', chunk)
    s.emit('a', chunk)
    s.emit('a', chunk)
    expect(s.pauses).toEqual([{ id: 'a', paused: true }])
    acknowledgements[2]()
    expect(s.pauses).toEqual([
      { id: 'a', paused: true },
      { id: 'a', paused: false }
    ])
  })

  it('stages a transferred snapshot ahead of any destination output', async () => {
    const s = await freshStream()
    s.initPtyStream()
    s.emit('a', 'stale')
    s.stage('a', snap('transferred'))
    s.emit('a', 'after-transfer')
    const got: string[] = []
    s.attachPty('a', (data, done) => {
      got.push(data)
      done()
    }, () => snap('next'), () => got.push('restored'))
    expect(got).toEqual(['transferred', 'restored', 'after-transfer'])
  })

  it('keeps the original snapshot when a replacement unmounts before restore completes', async () => {
    const s = await freshStream()
    s.initPtyStream()
    s.stage('a', snap('original'))
    let finishOldRestore = (): void => {}
    const detach = s.attachPty('a', (_data, done) => {
      finishOldRestore = done
    }, () => snap('partial'))
    detach()

    const got: string[] = []
    s.attachPty('a', (data, done) => {
      got.push(data)
      done()
    }, () => snap('next'))
    finishOldRestore()
    expect(got).toEqual(['original'])
  })

  it('releases backpressure and waiters when a terminal exits', async () => {
    const s = await freshStream()
    s.initPtyStream()
    s.emit('a', 'x'.repeat(300 * 1024))
    const capture = s.capturePtySnapshot('a')
    s.retainOnly(new Set())
    await expect(capture).resolves.toBeNull()
    expect(s.pauses).toEqual([
      { id: 'a', paused: true },
      { id: 'a', paused: false }
    ])
  })
})
