import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The renderer's PTY output fan-out.
 *
 * This module is the ONLY place PTY output is retained — main does not keep it and the agents do not —
 * so anything it drops is gone for good, and a terminal that attaches to an empty record shows a blank
 * screen until something produces more output. Three properties carry that weight:
 *
 *  1. **One writer per terminal.** A second attach for the same id replaces the first, and the first
 *     is never restored. This is a property of the fan-out, not a policy: it cannot express two.
 *  2. **The record is RETAINED, not drained.** Attaching replays without consuming, and chunks are
 *     recorded whether or not anyone is listening. This is what makes moving a terminal between panes
 *     and windows non-destructive: an xterm is destroyed and rebuilt by such a move, and with a
 *     drain-on-attach buffer the rebuilt one had nothing to repaint from, so "move it" meant "blank
 *     it". These tests are the difference between that being fixed and it silently regressing.
 *  3. **The record is bounded, and bounded from the FRONT.** Retention with no end is a leak, so the
 *     window is capped and the OLDEST goes first — dropping the newest would leave an attaching
 *     terminal showing stale output, and dropping without a floor would discard a single chunk larger
 *     than the cap and show nothing at all.
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
  retainOnly: (ids: Set<string>) => void
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
    retainOnly: mod.retainOnly,
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

  it('replays to EVERY terminal that attaches, without consuming', async () => {
    // The inversion of the old contract, and the point of the whole module. This used to assert the
    // second attach got nothing, because the first drained the buffer — which is exactly why moving a
    // terminal blanked it: the move destroys the xterm and builds a new one, and the new one arrived
    // to an empty record. Retention is what a rebuilt terminal repaints from.
    const s = await freshStream()
    s.initPtyStream()
    s.emit('a', 'only')
    const first: string[] = []
    s.attachPty('a', (d) => first.push(d))
    const second: string[] = []
    s.attachPty('a', (d) => second.push(d))
    expect(first).toEqual(['only'])
    expect(second).toEqual(['only'])
  })
})

describe('ptyStream — a terminal survives being moved', () => {
  it('replays everything seen so far into a terminal rebuilt elsewhere', async () => {
    // What a pane or window move actually looks like from here: the old writer detaches, a brand-new
    // terminal attaches for the same id, and it must come up showing the session rather than blank.
    const s = await freshStream()
    s.initPtyStream()
    s.emit('a', 'prompt$ ')
    const inPaneOne: string[] = []
    const detach = s.attachPty('a', (d) => inPaneOne.push(d))
    s.emit('a', 'running…')
    detach()

    const inPaneTwo: string[] = []
    s.attachPty('a', (d) => inPaneTwo.push(d))
    // Both chunks, in order — including the one delivered live to the first terminal, which is the
    // half a drained buffer lost.
    expect(inPaneTwo).toEqual(['prompt$ ', 'running…'])
  })

  it('records while a writer is attached, so the NEXT attach is current', async () => {
    // Delivering to an attached writer must not be an alternative to recording. If recording only
    // happened when nobody was listening, a terminal moved after a long working session would repaint
    // to whatever was on screen before it was first attached — stale, and worse than blank.
    const s = await freshStream()
    s.initPtyStream()
    const live: string[] = []
    const detach = s.attachPty('a', (d) => live.push(d))
    s.emit('a', 'one')
    s.emit('a', 'two')
    detach()
    const rebuilt: string[] = []
    s.attachPty('a', (d) => rebuilt.push(d))
    expect(live).toEqual(['one', 'two'])
    expect(rebuilt).toEqual(['one', 'two'])
  })
})

describe('ptyStream — retention ends', () => {
  it('forgets a terminal that is no longer live', async () => {
    // Retention is unbounded in time, so it needs an end or a window leaks one full buffer per
    // terminal it has ever seen. Asserted by attaching AFTER the sweep: a fresh terminal for a dead id
    // gets nothing.
    const s = await freshStream()
    s.initPtyStream()
    s.emit('dead', 'gone')
    s.emit('alive', 'kept')
    s.retainOnly(new Set(['alive']))
    const dead: string[] = []
    s.attachPty('dead', (d) => dead.push(d))
    const alive: string[] = []
    s.attachPty('alive', (d) => alive.push(d))
    expect(dead).toEqual([])
    // The other half: the sweep must not be a clear-everything. A live terminal keeps its record.
    expect(alive).toEqual(['kept'])
  })

  it('keeps recording for a live terminal after a sweep', async () => {
    // Proves the sweep drops the RECORD and not the subscription — a swept-then-still-live id must go
    // on being recorded, or the first move after any session ending would come up blank.
    const s = await freshStream()
    s.initPtyStream()
    s.emit('a', 'before')
    s.retainOnly(new Set(['a']))
    s.emit('a', 'after')
    const got: string[] = []
    s.attachPty('a', (d) => got.push(d))
    expect(got).toEqual(['before', 'after'])
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

  it('bounds continuously across an attach, rather than restarting at zero', async () => {
    // The cap is a property of the rolling window, so attaching is not an event it resets. The two
    // behaviours are distinguishable and this asserts which one is in force: six 64KB chunks against a
    // 256KB cap leave D, E, F. Were the record cleared and the tally zeroed on attach — the old
    // drain semantics — the last two alone would fit and this would read ['E', 'F'].
    const s = await freshStream()
    s.initPtyStream()
    const chunk = 'x'.repeat(64 * 1024)
    for (const tag of ['A', 'B', 'C', 'D']) s.emit('a', tag + chunk)
    const detach = s.attachPty('a', () => {})
    detach()
    for (const tag of ['E', 'F']) s.emit('a', tag + chunk)
    const got: string[] = []
    s.attachPty('a', (d) => got.push(d))
    expect(got.map((d) => d[0])).toEqual(['D', 'E', 'F'])
  })
})
