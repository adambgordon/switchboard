import { describe, expect, it } from 'vitest'
import { nextPtyHomes, partitionPtys, type HomeContext } from '../src/renderer/lib/ptyHome'

/**
 * Terminal-to-pane assignment. The stakes are why this is pure rather than living in the effect that
 * calls it: a window holds one xterm per terminal, so moving one between panes means unmounting and
 * remounting it — and a remounted xterm attaches to an empty backlog, since no PTY output is kept
 * anywhere to replay. A regression here does not throw or look wrong in a diff; it produces a blank
 * terminal that only a resize recovers.
 */
const pty = (ptyId: string, sessionId: string) => ({ ptyId, sessionId })

/** A context where `tabs` maps a session id to the pane holding its tab. */
function ctx(
  paneCount: number,
  focusIndex: number,
  tabs: Record<string, number> = {}
): HomeContext {
  return {
    paneCount,
    focusIndex,
    paneOfSession: (id) => (id in tabs ? tabs[id] : null)
  }
}

describe('nextPtyHomes — first assignment', () => {
  it('homes a new terminal to the pane holding its tab', () => {
    const out = nextPtyHomes({}, [pty('t1', 'S1')], ctx(2, 0, { S1: 1 }))
    expect(out).toEqual({ t1: 1 })
  })

  it('homes a terminal with no tab anywhere to the focused pane', () => {
    // Reachable: the PTY list arrives over IPC and can land a beat before the tab is created.
    expect(nextPtyHomes({}, [pty('t1', 'S1')], ctx(2, 1))).toEqual({ t1: 1 })
    expect(nextPtyHomes({}, [pty('t1', 'S1')], ctx(2, 0))).toEqual({ t1: 0 })
  })

  it('clamps the focused-pane fallback to a pane that exists', () => {
    // A stale focusIndex must never produce a home no pane will ever mount.
    expect(nextPtyHomes({}, [pty('t1', 'S1')], ctx(1, 1))).toEqual({ t1: 0 })
  })

  it('pane 0 is a real answer, not a falsy one', () => {
    // The tab pane is looked up with `??`, not `||` — pane 0 is a valid home and must not be treated
    // as "no tab" and replaced by the focused pane.
    expect(nextPtyHomes({}, [pty('t1', 'S1')], ctx(2, 1, { S1: 0 }))).toEqual({ t1: 0 })
  })
})

describe('nextPtyHomes — stickiness', () => {
  it('does NOT follow a tab that moved to the other pane', () => {
    // The load-bearing rule. Following the tab would remount the xterm and blank the terminal; the
    // pane that owns it keeps showing it, and the other pane shows that conversation's transcript.
    const prev = { t1: 0 }
    expect(nextPtyHomes(prev, [pty('t1', 'S1')], ctx(2, 1, { S1: 1 }))).toBe(prev)
  })

  it('does not move a terminal when the focus moves', () => {
    const prev = { t1: 0 }
    expect(nextPtyHomes(prev, [pty('t1', 'S1')], ctx(2, 1))).toBe(prev)
  })

  it('does not move a terminal when its tab is closed', () => {
    // No tab anywhere, but it is already homed — it stays mounted where it is so its scrollback
    // survives closing the tab.
    const prev = { t1: 1 }
    expect(nextPtyHomes(prev, [pty('t1', 'S1')], ctx(2, 0))).toBe(prev)
  })

  it('returns the previous map by identity when nothing changes', () => {
    // Not cosmetic: this runs on every re-index while a session is live, and a fresh object each pass
    // would re-render the whole pane tree twice a second.
    const prev = { t1: 0, t2: 1 }
    expect(nextPtyHomes(prev, [pty('t1', 'S1'), pty('t2', 'S2')], ctx(2, 0))).toBe(prev)
  })
})

describe('nextPtyHomes — a pane going away', () => {
  it('re-homes a terminal whose pane no longer exists', () => {
    // The one case that MUST move: an unsplit. It changes the surviving pane's width too, so the
    // remounted terminal is repainted by the resize that follows.
    expect(nextPtyHomes({ t1: 1 }, [pty('t1', 'S1')], ctx(1, 0, { S1: 0 }))).toEqual({ t1: 0 })
  })

  it('re-homes to the merged pane even with no tab left for it', () => {
    expect(nextPtyHomes({ t1: 1 }, [pty('t1', 'S1')], ctx(1, 0))).toEqual({ t1: 0 })
  })

  it('leaves the other panes’ terminals alone while re-homing one', () => {
    const out = nextPtyHomes(
      { a: 0, b: 1, c: 0 },
      [pty('a', 'A'), pty('b', 'B'), pty('c', 'C')],
      ctx(1, 0)
    )
    expect(out).toEqual({ a: 0, b: 0, c: 0 })
  })
})

describe('nextPtyHomes — forgetting exited terminals', () => {
  it('drops entries for terminals that are gone', () => {
    // Without this the map grows for the life of the window, keyed by ids that will never return.
    expect(nextPtyHomes({ t1: 0, t2: 1 }, [pty('t2', 'S2')], ctx(2, 0))).toEqual({ t2: 1 })
  })

  it('drops an exited terminal even when no live one needs re-homing', () => {
    // Separate case: the assignment loop makes no edit at all here, so the cleanup has to create the
    // copy on its own rather than riding along with one.
    expect(nextPtyHomes({ dead: 0 }, [], ctx(1, 0))).toEqual({})
  })
})

describe('partitionPtys', () => {
  it('puts each terminal in its own pane', () => {
    const out = partitionPtys(
      [pty('a', 'A'), pty('b', 'B'), pty('c', 'C')],
      { a: 0, b: 1, c: 0 },
      2
    )
    expect(out.map((g) => g.map((p) => p.ptyId))).toEqual([['a', 'c'], ['b']])
  })

  it('leaves an unhomed terminal in NO pane', () => {
    // For one frame only. Guessing a pane and correcting next frame would remount the xterm, which is
    // exactly the cost the sticky rule exists to avoid.
    const out = partitionPtys([pty('a', 'A'), pty('b', 'B')], { a: 1 }, 2)
    expect(out.map((g) => g.map((p) => p.ptyId))).toEqual([[], ['a']])
  })

  it('falls a terminal homed to a vanished pane to pane 0 immediately', () => {
    // So an unsplit moves it in one step rather than blinking it out for a frame first.
    const out = partitionPtys([pty('a', 'A')], { a: 1 }, 1)
    expect(out.map((g) => g.map((p) => p.ptyId))).toEqual([['a']])
  })

  it('always returns at least one group', () => {
    // A layout with no pane is not representable, but the partition must not hand back an empty array
    // that a caller would index into.
    expect(partitionPtys([], {}, 0)).toEqual([[]])
  })
})
