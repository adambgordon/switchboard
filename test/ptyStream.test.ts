import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The renderer's PTY output fan-out.
 *
 * Two properties here are load-bearing far out of proportion to the file's size, and both are about
 * output that CANNOT be recovered: nothing anywhere retains PTY bytes to replay, so anything this
 * drops is gone, and a terminal that attaches to an empty backlog shows a blank screen until
 * something changes its size.
 *
 *  1. **One writer per terminal.** A second attach for the same id replaces the first, and the first
 *     is never restored — which is the reason a terminal is confined to one pane and one window.
 *  2. **The backlog is bounded, and bounded from the FRONT.** Every window receives every terminal's
 *     output, so a window showing one conversation is buffering all the others with no writer to
 *     consume them. Dropping the newest instead of the oldest would leave an attaching terminal
 *     showing stale output; dropping without a floor would discard a single chunk larger than the cap
 *     and show nothing at all.
 *
 * `ptyStream` holds module state and subscribes through `window.api`, so each test re-imports it
 * against a fresh stub. That is the same shape as the suites that drive `PtyManager` and the identity
 * resolver: reach for it when the behaviour lives in the statefulness rather than in a return value.
 */

/** Matches ptyStream's own MAX_BUFFER_BYTES. Deliberately duplicated rather than imported: if the
 *  module's cap changes, these tests should FAIL and be re-reasoned, not silently follow it. */
const CAP = 256 * 1024

type Emit = (id: string, data: string) => void

/** Fresh module + fresh stub, returning the emitter main would be pushing through. */
async function freshStream(): Promise<{
  emit: Emit
  attachPty: (id: string, writer: (d: string) => void) => () => void
  initPtyStream: () => void
  subscribeCount: () => number
}> {
  vi.resetModules()
  let emit: Emit = () => {}
  let subscribes = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onPtyData: (cb: Emit) => {
        subscribes += 1
        emit = cb
        return () => {}
      }
    }
  }
  const mod = await import('../src/renderer/lib/ptyStream')
  return {
    emit: (id, data) => emit(id, data),
    attachPty: mod.attachPty,
    initPtyStream: mod.initPtyStream,
    subscribeCount: () => subscribes
  }
}

describe('ptyStream — the single subscription', () => {
  it('subscribes exactly once however many terminals attach', async () => {
    const s = await freshStream()
    s.initPtyStream()
    s.attachPty('a', () => {})
    s.attachPty('b', () => {})
    s.initPtyStream()
    expect(s.subscribeCount()).toBe(1)
  })
})

describe('ptyStream — delivery', () => {
  it('hands data straight to an attached writer', async () => {
    const s = await freshStream()
    const got: string[] = []
    s.attachPty('a', (d) => got.push(d))
    s.emit('a', 'one')
    s.emit('a', 'two')
    expect(got).toEqual(['one', 'two'])
  })

  it('routes each terminal to its own writer only', async () => {
    const s = await freshStream()
    const a: string[] = []
    const b: string[] = []
    s.attachPty('a', (d) => a.push(d))
    s.attachPty('b', (d) => b.push(d))
    s.emit('a', 'for-a')
    s.emit('b', 'for-b')
    expect(a).toEqual(['for-a'])
    expect(b).toEqual(['for-b'])
  })

  it('replays the backlog in order when a terminal attaches late', async () => {
    // The case the buffer exists for: a session emits its shell prompt and the start of the agent
    // between spawning and its terminal mounting.
    const s = await freshStream()
    s.initPtyStream()
    s.emit('a', 'first')
    s.emit('a', 'second')
    const got: string[] = []
    s.attachPty('a', (d) => got.push(d))
    expect(got).toEqual(['first', 'second'])
  })

  it('consumes the backlog exactly once', async () => {
    // Whichever terminal attaches first drains it. A second attach getting the same bytes again would
    // paint them twice; this pins that it gets nothing instead.
    const s = await freshStream()
    s.initPtyStream()
    s.emit('a', 'only')
    const first: string[] = []
    s.attachPty('a', (d) => first.push(d))
    const second: string[] = []
    s.attachPty('a', (d) => second.push(d))
    expect(first).toEqual(['only'])
    expect(second).toEqual([])
  })
})

describe('ptyStream — one writer per terminal', () => {
  it('a second attach takes over, and the first stops receiving', async () => {
    // This is WHY a terminal lives in exactly one pane and one window. Not a limitation to route
    // around — the fan-out cannot express two.
    const s = await freshStream()
    const first: string[] = []
    const second: string[] = []
    s.attachPty('a', (d) => first.push(d))
    s.attachPty('a', (d) => second.push(d))
    s.emit('a', 'after')
    expect(first).toEqual([])
    expect(second).toEqual(['after'])
  })

  it('detaching a superseded writer does not unhook the current one', async () => {
    // The `writers.get(id) === writer` guard. Without it, the first terminal's cleanup would remove
    // the SECOND terminal's writer, and output would start buffering behind a live, visible terminal.
    const s = await freshStream()
    const first: string[] = []
    const second: string[] = []
    const detachFirst = s.attachPty('a', (d) => first.push(d))
    s.attachPty('a', (d) => second.push(d))
    detachFirst()
    s.emit('a', 'still-live')
    expect(second).toEqual(['still-live'])
  })

  it('detaching the current writer sends later output back to the buffer', async () => {
    const s = await freshStream()
    const got: string[] = []
    const detach = s.attachPty('a', (d) => got.push(d))
    detach()
    s.emit('a', 'buffered')
    expect(got).toEqual([])
    const next: string[] = []
    s.attachPty('a', (d) => next.push(d))
    expect(next).toEqual(['buffered'])
  })
})

describe('ptyStream — the backlog is bounded', () => {
  it('drops the OLDEST chunks and keeps the newest', async () => {
    // A window showing one conversation still receives every other terminal's output with no writer
    // to consume it, so this bound is what stops an unattended terminal growing without limit. Keeping
    // the newest is the half that matters: an attaching terminal must show current output, not stale.
    const s = await freshStream()
    s.initPtyStream()
    const chunk = 'x'.repeat(64 * 1024)
    for (const tag of ['A', 'B', 'C', 'D', 'E', 'F']) s.emit('a', tag + chunk)
    const got: string[] = []
    s.attachPty('a', (d) => got.push(d))
    const total = got.reduce((n, d) => n + d.length, 0)
    expect(total).toBeLessThanOrEqual(CAP)
    // The last chunks survive, the first ones are gone — asserted on the full sequence of tags so an
    // implementation that dropped from the back, or kept an arbitrary subset, cannot pass.
    expect(got.map((d) => d[0])).toEqual(['D', 'E', 'F'])
  })

  it('bounds each terminal separately', async () => {
    // A noisy terminal must not evict a quiet one's backlog.
    const s = await freshStream()
    s.initPtyStream()
    s.emit('quiet', 'keep-me')
    const chunk = 'x'.repeat(64 * 1024)
    for (const tag of ['A', 'B', 'C', 'D', 'E', 'F']) s.emit('noisy', tag + chunk)
    const quiet: string[] = []
    s.attachPty('quiet', (d) => quiet.push(d))
    expect(quiet).toEqual(['keep-me'])
  })

  it('keeps a single chunk even when it alone exceeds the cap', async () => {
    // The `b.length > 1` floor. Without it an over-cap chunk is dropped outright and the attaching
    // terminal shows NOTHING — strictly worse than showing more than the budget once.
    const s = await freshStream()
    s.initPtyStream()
    const huge = 'y'.repeat(CAP + 1024)
    s.emit('a', huge)
    const got: string[] = []
    s.attachPty('a', (d) => got.push(d))
    expect(got).toEqual([huge])
  })

  it('starts counting again from zero after a terminal attaches', async () => {
    // The byte tally is deleted with the backlog. Leaving it behind would make the NEXT detached
    // stretch start already near the cap and evict output that fits.
    const s = await freshStream()
    s.initPtyStream()
    const chunk = 'x'.repeat(64 * 1024)
    for (const tag of ['A', 'B', 'C', 'D']) s.emit('a', tag + chunk)
    const detach = s.attachPty('a', () => {})
    detach()
    for (const tag of ['E', 'F']) s.emit('a', tag + chunk)
    const got: string[] = []
    s.attachPty('a', (d) => got.push(d))
    expect(got.map((d) => d[0])).toEqual(['E', 'F'])
  })
})
