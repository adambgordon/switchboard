import { describe, expect, it } from 'vitest'
import type { PtySnapshot } from '../src/shared/types'
import { transferPty, type PtyTransferOps } from '../src/main/pty/transfer'

const snapshot: PtySnapshot = {
  data: 'state',
  cols: 80,
  rows: 24,
  viewportFromBottom: 0
}

function operations(captured: PtySnapshot | null, staged = true) {
  const events: string[] = []
  const ops: PtyTransferOps = {
    pause: () => events.push('pause'),
    resume: () => events.push('resume'),
    capture: async () => {
      events.push('capture')
      return captured
    },
    stage: () => {
      events.push('stage')
      return staged
    },
    commit: () => events.push('commit'),
    repaintUnowned: () => events.push('repaint')
  }
  return { events, ops }
}

describe('transferPty', () => {
  it('stages captured state before committing the new owner', async () => {
    const { events, ops } = operations(snapshot)
    await expect(transferPty(1, 2, ops)).resolves.toBe(true)
    expect(events).toEqual(['pause', 'capture', 'stage', 'commit', 'resume'])
  })

  it('keeps the old owner and always resumes when capture fails', async () => {
    const { events, ops } = operations(null)
    await expect(transferPty(1, 2, ops)).resolves.toBe(false)
    expect(events).toEqual(['pause', 'capture', 'resume'])
  })

  it('does not commit when the destination cannot stage the snapshot', async () => {
    const { events, ops } = operations(snapshot, false)
    await expect(transferPty(1, 2, ops)).resolves.toBe(false)
    expect(events).toEqual(['pause', 'capture', 'stage', 'resume'])
  })

  it('claims an unowned terminal and repaints without asking for a snapshot', async () => {
    const { events, ops } = operations(snapshot)
    await expect(transferPty(undefined, 2, ops)).resolves.toBe(true)
    expect(events).toEqual(['commit', 'repaint'])
  })

  it('is inert when the requester already owns the terminal', async () => {
    const { events, ops } = operations(snapshot)
    await expect(transferPty(2, 2, ops)).resolves.toBe(true)
    expect(events).toEqual([])
  })
})
