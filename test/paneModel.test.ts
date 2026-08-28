import { describe, expect, it } from 'vitest'
import {
  SPLIT_LIMITS,
  activeTabId,
  initialLayout,
  locateTab,
  openSessionIds,
  paneReducer,
  stepTab,
  tabSequence,
  type Pane,
  type PaneAction,
  type PaneLayout,
  type Tab
} from '../src/renderer/lib/paneModel'

/**
 * The tab / pane model. Selection is DERIVED from this (the active tab of the focused pane), so a
 * wrong answer here is a wrong conversation on screen — which is why the whole reducer is pure and
 * tested rather than living in a hook.
 *
 * Two fixture rules this file follows deliberately, both learned the hard way elsewhere in the repo:
 *
 *   1. **Assert the full result, and separate the ids under test.** Two different wrong behaviours
 *      must not be able to produce the same array. Adjacent ids are where that goes wrong — "drop the
 *      stale tab and keep this one in place" and "keep the stale tab's slot and drop this one" emit
 *      an identical list when the two sit side by side.
 *   2. **Check the invariants after every single action.** Several rules here (at most one preview
 *      tab per pane, no duplicate conversation within a pane, activeIndex in range) are properties no
 *      individual assertion is about, and a violation of one shows up as a nonsense UI rather than a
 *      failing expectation. `step()` enforces them on every transition below.
 */

const t = (sessionId: string, preview = false): Tab => ({ sessionId, preview })
const pane = (id: string, tabs: Tab[], activeIndex: number): Pane => ({ id, tabs, activeIndex })

function layout(panes: Pane[], focusIndex = 0, splitFraction = SPLIT_LIMITS.default): PaneLayout {
  return { panes, focusIndex, splitFraction }
}

/** Structural rules that must hold after every transition, whatever the action was. */
function expectInvariants(l: PaneLayout): void {
  expect(l.panes.length).toBeGreaterThanOrEqual(1)
  expect(l.panes.length).toBeLessThanOrEqual(2)
  expect(l.focusIndex).toBeGreaterThanOrEqual(0)
  expect(l.focusIndex).toBeLessThan(l.panes.length)
  expect(new Set(l.panes.map((p) => p.id)).size).toBe(l.panes.length)
  expect(l.splitFraction).toBeGreaterThanOrEqual(SPLIT_LIMITS.min)
  expect(l.splitFraction).toBeLessThanOrEqual(SPLIT_LIMITS.max)
  for (const p of l.panes) {
    // -1 is required when empty and ALLOWED when tabs are open (the welcome screen); anything else
    // must be a real index. A value past the end is the failure this is really guarding against.
    if (p.tabs.length === 0) expect(p.activeIndex).toBe(-1)
    else {
      expect(p.activeIndex).toBeGreaterThanOrEqual(-1)
      expect(p.activeIndex).toBeLessThan(p.tabs.length)
    }
    // One conversation cannot hold two tabs in one pane, and a pane cannot hold two preview tabs —
    // either would make "replace the preview tab" and "activate the existing tab" ambiguous.
    expect(new Set(p.tabs.map((x) => x.sessionId)).size).toBe(p.tabs.length)
    expect(p.tabs.filter((x) => x.preview).length).toBeLessThanOrEqual(1)
  }
  // NOTE: window-wide uniqueness — one conversation, one tab anywhere — is upheld by every action
  // that can introduce an id (`open`, `move`, `rekey`, `retarget`), and each asserts it directly. It is
  // deliberately NOT a blanket invariant here, because two tests below start from a duplicate fixture
  // ON PURPOSE: they pin that `promote` and `rekey` are pane-scoped, and the only way to show a pane
  // was left alone is to give it something to leave alone. Those fixtures are states the reducer can
  // no longer produce, which is exactly why they have to be built by hand.
}

/** Apply one action and assert the invariants survived it. */
function step(l: PaneLayout, action: PaneAction): PaneLayout {
  const next = paneReducer(l, action)
  expectInvariants(next)
  return next
}

describe('initialLayout', () => {
  it('is a single empty pane with nothing selected', () => {
    const l = initialLayout('p0')
    expectInvariants(l)
    expect(l).toEqual({
      panes: [{ id: 'p0', tabs: [], activeIndex: -1 }],
      focusIndex: 0,
      splitFraction: SPLIT_LIMITS.default
    })
    expect(activeTabId(l)).toBeNull()
  })
})

describe('open — preview tabs', () => {
  it('opens into an empty pane as a preview tab', () => {
    const l = step(initialLayout('p0'), { type: 'open', sessionId: 'A', mode: 'preview' })
    expect(l.panes[0].tabs).toEqual([t('A', true)])
    expect(l.panes[0].activeIndex).toBe(0)
  })

  it('replaces the preview tab IN PLACE, holding its slot', () => {
    // The whole point of a preview tab: walking a list must not march a tab rightwards across the
    // strip, nor append a new one per click. Tabs exist on BOTH sides of the preview slot so that
    // "append and activate" (→ A,P,C,D) and "replace but relocate" (→ A,C,D) are both distinguishable.
    const before = layout([pane('p0', [t('A'), t('P', true), t('C')], 1)])
    const after = step(before, { type: 'open', sessionId: 'D', mode: 'preview' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('D', true), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
  })

  it('replaces the preview tab even when the preview tab is not the active one', () => {
    // Reachable by ⌘+clicking a row (which opens a persistent tab and leaves the selection alone)
    // and then clicking another row: the preview slot is still the one that must be reused.
    const before = layout([pane('p0', [t('A'), t('P', true), t('C')], 0)])
    const after = step(before, { type: 'open', sessionId: 'D', mode: 'preview' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('D', true), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
  })

  it('inserts after the active tab when there is no preview tab to reuse', () => {
    // Not at the end: an opened conversation belongs next to the one it was opened from. Active is
    // deliberately 0 with tabs after it, so "append" (→ A,B,C,D) is a different array.
    const before = layout([pane('p0', [t('A'), t('B'), t('C')], 0)])
    const after = step(before, { type: 'open', sessionId: 'D', mode: 'preview' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('D', true), t('B'), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
  })
})

describe('open — persistent tabs', () => {
  it('does not consume the preview slot', () => {
    // A persistent open (⌘+click, or a promotion trigger) must leave the pane's preview tab intact,
    // so the next ordinary click still has a slot to reuse rather than pushing another tab.
    const before = layout([pane('p0', [t('A'), t('P', true)], 0)])
    const after = step(before, { type: 'open', sessionId: 'D', mode: 'persistent' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('D'), t('P', true)])
    expect(after.panes[0].activeIndex).toBe(1)
  })

  it('a background open inserts without moving the selection or the pane focus', () => {
    // ⌘+click: queue a conversation up without losing your place. Two separate wrongs to exclude —
    // activating the new tab, and pulling keyboard focus to the other pane.
    const before = layout([pane('p0', [t('A'), t('B')], 0), pane('p1', [t('C')], 0)], 1)
    const after = step(before, {
      type: 'open',
      sessionId: 'D',
      mode: 'persistent',
      pane: 0,
      focus: false
    })
    expect(after.panes[0].tabs).toEqual([t('A'), t('D'), t('B')])
    expect(after.panes[0].activeIndex).toBe(0)
    expect(after.focusIndex).toBe(1)
  })
})

describe('open — a conversation already open here', () => {
  it('activates the existing tab instead of opening a second one', () => {
    const before = layout([pane('p0', [t('A'), t('B'), t('C')], 2)])
    const after = step(before, { type: 'open', sessionId: 'A', mode: 'preview' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B'), t('C')])
    expect(after.panes[0].activeIndex).toBe(0)
  })

  it('a persistent open makes an already-open preview tab stick', () => {
    // Clicking through to a preview tab and then acting on it is the ordinary way a tab earns its
    // place; the flag must clear without the tab moving.
    const before = layout([pane('p0', [t('A'), t('B', true)], 0)])
    const after = step(before, { type: 'open', sessionId: 'B', mode: 'persistent' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B')])
    expect(after.panes[0].activeIndex).toBe(1)
  })

  it('a preview open leaves an already-open persistent tab persistent', () => {
    const before = layout([pane('p0', [t('A'), t('B')], 0)])
    const after = step(before, { type: 'open', sessionId: 'B', mode: 'preview' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B')])
    expect(after.panes[0].activeIndex).toBe(1)
  })
})

describe('open — one tab per conversation, wherever it already is', () => {
  // A conversation holds ONE tab in the window. What an open does when it already has one depends on
  // whether the caller named a pane, and the two cases are opposites — so each is asserted against a
  // fixture where the other answer would be visibly different.

  it('REVEALS it in the other pane when no pane was named', () => {
    // A rail click, a resume, ⌘1-9: "show me this". It is already open, so focus goes to it — the tab
    // does not come to the user, and no second tab appears.
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('B'), t('C')], 0)], 0)
    const after = step(before, { type: 'open', sessionId: 'C', mode: 'preview' })
    expect(after.panes[0].tabs).toEqual([t('A')])
    expect(after.panes[1].tabs).toEqual([t('B'), t('C')])
    // Focus followed the conversation into the pane that holds it.
    expect(after.focusIndex).toBe(1)
    expect(after.panes[1].activeIndex).toBe(1)
  })

  it('MOVES it when a pane was named explicitly', () => {
    // Split Right, open-to-side, a drop: a placement instruction, so the tab relocates.
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('B'), t('C')], 0)], 0)
    const after = step(before, { type: 'open', sessionId: 'C', mode: 'preview', pane: 0 })
    expect(after.panes[0].tabs.map((x) => x.sessionId)).toEqual(['A', 'C'])
    expect(after.panes[1].tabs).toEqual([t('B')])
    expect(after.focusIndex).toBe(0)
  })

  it('never leaves two tabs for one conversation', () => {
    // The property both cases exist to protect, asserted on the whole window rather than per pane.
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('B')], 0)], 0)
    for (const id of ['A', 'B']) {
      for (const p of [undefined, 0, 1]) {
        const after = step(before, { type: 'open', sessionId: id, mode: 'preview', pane: p })
        const all = after.panes.flatMap((x) => x.tabs.map((y) => y.sessionId))
        expect(new Set(all).size).toBe(all.length)
      }
    }
  })

  it('promotes where the tab actually is, not where focus was', () => {
    // A persistent open on a tab living in the unfocused pane must clear ITS preview flag — reaching
    // into the pane that holds the tab, not the one the user happened to be in.
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('B', true)], 0)], 0)
    const after = step(before, { type: 'open', sessionId: 'B', mode: 'persistent' })
    expect(after.panes[1].tabs).toEqual([t('B')])
  })

  it('opens into the focused pane when the requested pane no longer exists', () => {
    // Callers hold pane indices across renders — a menu opened before an unsplit, say. A stale index
    // has to land somewhere sane rather than throwing or writing past the end of the array.
    const before = layout([pane('p0', [t('A')], 0)])
    const after = step(before, { type: 'open', sessionId: 'B', mode: 'preview', pane: 1 })
    expect(after.panes).toHaveLength(1)
    expect(after.panes[0].tabs).toEqual([t('A'), t('B', true)])
  })
})

describe('promote', () => {
  it('promotes only in the focused pane, never its twin in the other pane', () => {
    // The same conversation may legitimately have a tab in both panes; promoting is about the one
    // being acted on. Two wrongs excluded: promoting both, and promoting the wrong pane's.
    const before = layout([pane('p0', [t('X', true)], 0), pane('p1', [t('X', true)], 0)], 1)
    const after = step(before, { type: 'promote', sessionId: 'X' })
    expect(after.panes[0].tabs).toEqual([t('X', true)])
    expect(after.panes[1].tabs).toEqual([t('X')])
  })

  it('is a no-op on a tab that already sticks, and on an id that is not open', () => {
    const persistent = layout([pane('p0', [t('A')], 0)])
    expect(paneReducer(persistent, { type: 'promote', sessionId: 'A' })).toBe(persistent)
    expect(paneReducer(persistent, { type: 'promote', sessionId: 'Z' })).toBe(persistent)
  })
})

describe('activate', () => {
  it('selects a tab and gives its pane the keyboard', () => {
    const before = layout([pane('p0', [t('A'), t('B')], 0), pane('p1', [t('C'), t('D')], 0)], 0)
    const after = step(before, { type: 'activate', pane: 1, index: 1 })
    expect(after.panes[1].activeIndex).toBe(1)
    expect(after.focusIndex).toBe(1)
    expect(after.panes[0].activeIndex).toBe(0)
  })

  it('is a no-op for an index or pane that does not exist', () => {
    const before = layout([pane('p0', [t('A')], 0)])
    expect(paneReducer(before, { type: 'activate', pane: 0, index: 5 })).toBe(before)
    expect(paneReducer(before, { type: 'activate', pane: 1, index: 0 })).toBe(before)
    expect(paneReducer(before, { type: 'activate', pane: 0, index: -1 })).toBe(before)
  })
})

describe('deselect — the welcome screen with tabs still open', () => {
  it('clears the focused pane’s selection without touching its tabs', () => {
    // Focus is on the RIGHT pane deliberately: with focus on pane 0 an implementation that always
    // deselects pane 0 would pass, and that is the mistake worth excluding.
    const before = layout([pane('p0', [t('A'), t('B')], 1), pane('p1', [t('C'), t('D')], 1)], 1)
    const after = step(before, { type: 'deselect' })
    expect(after.panes[1].tabs).toEqual([t('C'), t('D')])
    expect(after.panes[1].activeIndex).toBe(-1)
    // The other pane is untouched, including its selection.
    expect(after.panes[0].activeIndex).toBe(1)
    expect(activeTabId(after)).toBeNull()
  })

  it('is a no-op when nothing is selected already', () => {
    const before = layout([pane('p0', [t('A')], -1)])
    expect(paneReducer(before, { type: 'deselect' })).toBe(before)
  })

  it('an open while deselected appends rather than jumping to the front of the strip', () => {
    const before = layout([pane('p0', [t('A'), t('B')], -1)])
    const after = step(before, { type: 'open', sessionId: 'D', mode: 'preview' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B'), t('D', true)])
    expect(after.panes[0].activeIndex).toBe(2)
  })

  it('closing a tab while deselected leaves the pane deselected', () => {
    const before = layout([pane('p0', [t('A'), t('B')], -1)])
    const after = step(before, { type: 'close', pane: 0, index: 0 })
    expect(after.panes[0].tabs).toEqual([t('B')])
    expect(after.panes[0].activeIndex).toBe(-1)
  })

  it('unsplit does not pull the user off the welcome screen', () => {
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('C')], -1)], 1)
    const after = step(before, { type: 'unsplit' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('C')])
    expect(after.panes[0].activeIndex).toBe(-1)
  })
})

describe('close', () => {
  it('selects the tab that slid into the closed slot', () => {
    const after = step(layout([pane('p0', [t('A'), t('B'), t('C')], 1)]), {
      type: 'close',
      pane: 0,
      index: 1
    })
    expect(after.panes[0].tabs).toEqual([t('A'), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
    expect(activeTabId(after)).toBe('C')
  })

  it('falls back to the left neighbour when the rightmost tab is closed', () => {
    const after = step(layout([pane('p0', [t('A'), t('B'), t('C')], 2)]), {
      type: 'close',
      pane: 0,
      index: 2
    })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B')])
    expect(activeTabId(after)).toBe('B')
  })

  it('keeps the same conversation selected when a tab BEFORE it is closed', () => {
    // The index has to shift down with it. Leaving it at 2 runs off the end; resetting it to 0
    // silently switches the user to a different conversation.
    const after = step(layout([pane('p0', [t('A'), t('B'), t('C')], 2)]), {
      type: 'close',
      pane: 0,
      index: 0
    })
    expect(after.panes[0].tabs).toEqual([t('B'), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
    expect(activeTabId(after)).toBe('C')
  })

  it('keeps the same conversation selected when a tab AFTER it is closed', () => {
    const after = step(layout([pane('p0', [t('A'), t('B'), t('C')], 0)]), {
      type: 'close',
      pane: 0,
      index: 2
    })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B')])
    expect(after.panes[0].activeIndex).toBe(0)
  })

  it('leaves the last pane empty rather than removing it', () => {
    // An empty single pane is the welcome screen; a window with no pane has nothing to render into.
    const after = step(layout([pane('p0', [t('A')], 0)]), { type: 'close', pane: 0, index: 0 })
    expect(after.panes).toEqual([{ id: 'p0', tabs: [], activeIndex: -1 }])
    expect(activeTabId(after)).toBeNull()
  })

  it('collapses an emptied pane in a split and leaves the survivor untouched', () => {
    // Two wrongs excluded: keeping a half-window pane with nothing in it, and resetting the
    // survivor's selection to its first tab.
    const before = layout([pane('p0', [t('A'), t('B')], 1), pane('p1', [t('C')], 0)], 1)
    const after = step(before, { type: 'close', pane: 1, index: 0 })
    expect(after.panes).toEqual([{ id: 'p0', tabs: [t('A'), t('B')], activeIndex: 1 }])
    expect(after.focusIndex).toBe(0)
    expect(activeTabId(after)).toBe('B')
  })

  it('keeps one pane when closing the last tab empties BOTH panes', () => {
    // Reachable: `split` opens an EMPTY second pane, so closing the only tab in the other one leaves
    // nothing anywhere. A layout with no pane has nowhere to render the welcome state.
    const split = step(layout([pane('p0', [t('A')], 0)]), { type: 'split', paneId: 'p1' })
    expect(split.panes).toHaveLength(2)
    const after = step(split, { type: 'close', pane: 0, index: 0 })
    expect(after.panes).toHaveLength(1)
    expect(after.panes[0].tabs).toEqual([])
    expect(after.focusIndex).toBe(0)
    expect(activeTabId(after)).toBeNull()
  })

  it('is a no-op for an index or pane that does not exist', () => {
    const before = layout([pane('p0', [t('A')], 0)])
    expect(paneReducer(before, { type: 'close', pane: 0, index: 3 })).toBe(before)
    expect(paneReducer(before, { type: 'close', pane: 4, index: 0 })).toBe(before)
  })
})

describe('closeOthers', () => {
  it('keeps only the named tab', () => {
    const after = step(layout([pane('p0', [t('A'), t('B', true), t('C')], 0)]), {
      type: 'closeOthers',
      pane: 0,
      index: 1
    })
    expect(after.panes[0].tabs).toEqual([t('B', true)])
    expect(after.panes[0].activeIndex).toBe(0)
  })
})

describe('move — within one strip', () => {
  it('keeps the same conversation selected after a reorder', () => {
    // Active is 0 with the moved tab being the active one, so an implementation that keeps the
    // numeric index (→ B) differs from one that follows the conversation (→ A at index 2).
    const after = step(layout([pane('p0', [t('A'), t('B'), t('C'), t('D')], 0)]), {
      type: 'move',
      from: { pane: 0, index: 0 },
      to: { pane: 0, index: 2 }
    })
    expect(after.panes[0].tabs).toEqual([t('B'), t('C'), t('A'), t('D')])
    expect(after.panes[0].activeIndex).toBe(2)
    expect(activeTabId(after)).toBe('A')
  })

  it('a reorder does not change whether a tab sticks', () => {
    // Rearranging a strip says nothing about whether a tab should be replaced by the next click.
    const after = step(layout([pane('p0', [t('A'), t('P', true), t('C')], 0)]), {
      type: 'move',
      from: { pane: 0, index: 1 },
      to: { pane: 0, index: 0 }
    })
    expect(after.panes[0].tabs).toEqual([t('P', true), t('A'), t('C')])
  })
})

describe('move — across panes', () => {
  it('promotes the arriving tab and leaves the destination its own preview slot', () => {
    // Both halves matter. The arriving tab must stop being a preview tab (two preview tabs in one
    // pane is not representable), and the pane's RESIDENT preview tab must survive — demoting it
    // would silently stop a pane the user is browsing in from reusing its slot.
    const before = layout([pane('p0', [t('A'), t('P', true)], 1), pane('p1', [t('Q', true)], 0)], 0)
    const after = step(before, {
      type: 'move',
      from: { pane: 0, index: 1 },
      to: { pane: 1, index: 0 }
    })
    expect(after.panes[0].tabs).toEqual([t('A')])
    expect(after.panes[1].tabs).toEqual([t('P'), t('Q', true)])
    expect(after.panes[1].activeIndex).toBe(0)
    expect(after.focusIndex).toBe(1)
  })

  it('the source keeps its own selection when a different tab is moved out', () => {
    const before = layout([pane('p0', [t('A'), t('B'), t('C')], 2), pane('p1', [t('Z')], 0)], 0)
    const after = step(before, {
      type: 'move',
      from: { pane: 0, index: 0 },
      to: { pane: 1, index: 1 }
    })
    expect(after.panes[0].tabs).toEqual([t('B'), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
    expect(after.panes[1].tabs).toEqual([t('Z'), t('A')])
  })

  it('activates the existing tab rather than duplicating a conversation', () => {
    const before = layout([pane('p0', [t('A'), t('X')], 0), pane('p1', [t('B'), t('X')], 0)], 0)
    const after = step(before, {
      type: 'move',
      from: { pane: 0, index: 1 },
      to: { pane: 1, index: 0 }
    })
    expect(after.panes[0].tabs).toEqual([t('A')])
    expect(after.panes[1].tabs).toEqual([t('B'), t('X')])
    expect(after.panes[1].activeIndex).toBe(1)
  })

  it('collapses the source pane when its last tab is dragged out', () => {
    const before = layout([pane('p0', [t('P')], 0), pane('p1', [t('Q')], 0)], 0)
    const after = step(before, {
      type: 'move',
      from: { pane: 0, index: 0 },
      to: { pane: 1, index: 1 }
    })
    expect(after.panes).toEqual([{ id: 'p1', tabs: [t('Q'), t('P')], activeIndex: 1 }])
    expect(after.focusIndex).toBe(0)
  })
})

describe('split / unsplit', () => {
  it('split adds an empty pane and hands it the keyboard', () => {
    const after = step(layout([pane('p0', [t('A')], 0)]), { type: 'split', paneId: 'p1' })
    expect(after.panes).toEqual([
      { id: 'p0', tabs: [t('A')], activeIndex: 0 },
      { id: 'p1', tabs: [], activeIndex: -1 }
    ])
    expect(after.focusIndex).toBe(1)
    // Nothing is selected yet — the new pane shows the welcome state until something is opened in it.
    expect(activeTabId(after)).toBeNull()
  })

  it('split is a no-op when already split', () => {
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('B')], 0)], 1)
    expect(paneReducer(before, { type: 'split', paneId: 'p2' })).toBe(before)
  })

  it('unsplit merges right into left, keeping what the user was looking at selected', () => {
    // Three separate wrongs excluded: keeping the LEFT pane's selection (→ A), demoting the left
    // pane's own preview tab, and letting the right pane's preview tab arrive still a preview (which
    // would leave two in one pane — the invariant check catches that one).
    const before = layout(
      [pane('p0', [t('A'), t('B', true)], 0), pane('p1', [t('C', true), t('D')], 1)],
      1
    )
    const after = step(before, { type: 'unsplit' })
    expect(after.panes).toEqual([
      { id: 'p0', tabs: [t('A'), t('B', true), t('C'), t('D')], activeIndex: 3 }
    ])
    expect(after.focusIndex).toBe(0)
    expect(activeTabId(after)).toBe('D')
  })

  it('unsplit does not duplicate a conversation open in both panes', () => {
    const before = layout([pane('p0', [t('A'), t('B')], 0), pane('p1', [t('B'), t('C')], 0)], 1)
    const after = step(before, { type: 'unsplit' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B'), t('C')])
    expect(activeTabId(after)).toBe('B')
  })

  it('unsplit is a no-op with one pane', () => {
    const before = layout([pane('p0', [t('A')], 0)])
    expect(paneReducer(before, { type: 'unsplit' })).toBe(before)
  })
})

describe('focusPane and setSplitFraction', () => {
  it('focusPane moves the keyboard, and no-ops for a pane that is not there or already focused', () => {
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('B')], 0)], 0)
    expect(step(before, { type: 'focusPane', index: 1 }).focusIndex).toBe(1)
    expect(paneReducer(before, { type: 'focusPane', index: 0 })).toBe(before)
    expect(paneReducer(before, { type: 'focusPane', index: 2 })).toBe(before)
    expect(paneReducer(before, { type: 'focusPane', index: -1 })).toBe(before)
  })

  it('setSplitFraction clamps at both ends and no-ops when unchanged', () => {
    const before = layout([pane('p0', [t('A')], 0), pane('p1', [t('B')], 0)], 0)
    expect(step(before, { type: 'setSplitFraction', value: 0.01 }).splitFraction).toBe(
      SPLIT_LIMITS.min
    )
    expect(step(before, { type: 'setSplitFraction', value: 0.99 }).splitFraction).toBe(
      SPLIT_LIMITS.max
    )
    expect(step(before, { type: 'setSplitFraction', value: 0.35 }).splitFraction).toBe(0.35)
    expect(
      paneReducer(before, { type: 'setSplitFraction', value: SPLIT_LIMITS.default })
    ).toBe(before)
  })
})

describe('closeMany / moveMany — acting on a multi-selection', () => {
  // These exist because a loop of single-tab actions cannot do the job: the caller resolves every
  // index against the layout it can see, and that stops being true the moment the first one lands.
  // Each test therefore uses NON-ADJACENT tabs, so an implementation that closed or moved by stale
  // index takes the wrong ones rather than coincidentally the right ones.

  it('closes a scattered set, not the ones their indices used to point at', () => {
    const before = layout([pane('p0', [t('A'), t('B'), t('C'), t('D'), t('E')], 0)])
    const after = step(before, { type: 'closeMany', sessionIds: ['A', 'C', 'E'] })
    expect(after.panes[0].tabs).toEqual([t('B'), t('D')])
  })

  it('keeps the active conversation selected when it survives', () => {
    const before = layout([pane('p0', [t('A'), t('B'), t('C'), t('D')], 3)])
    const after = step(before, { type: 'closeMany', sessionIds: ['A', 'B'] })
    expect(activeTabId(after)).toBe('D')
  })

  it('falls back to a neighbour when the active one was closed', () => {
    const before = layout([pane('p0', [t('A'), t('B'), t('C'), t('D')], 1)])
    const after = step(before, { type: 'closeMany', sessionIds: ['B', 'D'] })
    expect(after.panes[0].tabs).toEqual([t('A'), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
  })

  it('collapses a pane it empties', () => {
    const before = layout([pane('p0', [t('A'), t('B')], 0), pane('p1', [t('C')], 0)], 0)
    const after = step(before, { type: 'closeMany', sessionIds: ['A', 'B'] })
    expect(after.panes).toHaveLength(1)
    expect(after.panes[0].tabs).toEqual([t('C')])
  })

  it('is a no-op for an empty set or ids that are not open', () => {
    const before = layout([pane('p0', [t('A')], 0)])
    expect(paneReducer(before, { type: 'closeMany', sessionIds: [] })).toBe(before)
    expect(paneReducer(before, { type: 'closeMany', sessionIds: ['ZZ'] })).toBe(before)
  })

  it('moves a scattered set across, keeping their DISPLAY order', () => {
    // Order comes from the strip, not from the caller's array — passed here deliberately jumbled, so
    // an implementation that trusted the argument order would land them E, A, C.
    const before = layout([pane('p0', [t('A'), t('B'), t('C'), t('D'), t('E')], 0), pane('p1', [t('Z')], 0)], 0)
    const after = step(before, { type: 'moveMany', sessionIds: ['E', 'A', 'C'], to: { pane: 1, index: 1 } })
    expect(after.panes[0].tabs).toEqual([t('B'), t('D')])
    expect(after.panes[1].tabs.map((x) => x.sessionId)).toEqual(['Z', 'A', 'C', 'E'])
  })

  it('promotes everything it moves', () => {
    // A deliberate placement is not a preview — and two preview tabs in one pane would break the
    // one-preview rule outright.
    const before = layout([pane('p0', [t('A', true), t('B')], 0), pane('p1', [t('Z')], 0)], 0)
    const after = step(before, { type: 'moveMany', sessionIds: ['A', 'B'], to: { pane: 1, index: 1 } })
    // Moving EVERY tab out empties the source, which then collapses — so one pane remains, and it is
    // the destination's list. `t()` defaults to preview:false, so this also asserts the promotion.
    expect(after.panes).toHaveLength(1)
    expect(after.panes[0].tabs).toEqual([t('Z'), t('A'), t('B')])
  })

  it('activates the arrival and focuses the destination', () => {
    const before = layout([pane('p0', [t('A'), t('B'), t('C')], 0), pane('p1', [t('Z')], 0)], 0)
    const after = step(before, { type: 'moveMany', sessionIds: ['A', 'B'], to: { pane: 1, index: 1 } })
    expect(after.focusIndex).toBe(1)
    expect(activeTabId(after)).toBe('A')
  })

  it('reorders within one pane', () => {
    // Destination index is resolved AFTER the movers are taken out, matching single-tab `move`.
    const before = layout([pane('p0', [t('A'), t('B'), t('C'), t('D')], 0)])
    const after = step(before, { type: 'moveMany', sessionIds: ['A', 'C'], to: { pane: 0, index: 1 } })
    expect(after.panes[0].tabs.map((x) => x.sessionId)).toEqual(['B', 'A', 'C', 'D'])
  })

  it('clamps a destination index past the end', () => {
    const before = layout([pane('p0', [t('A'), t('B')], 0), pane('p1', [t('Z')], 0)], 0)
    const after = step(before, { type: 'moveMany', sessionIds: ['A'], to: { pane: 1, index: 99 } })
    expect(after.panes[1].tabs.map((x) => x.sessionId)).toEqual(['Z', 'A'])
  })

  it('is a no-op for an empty set, unknown ids, or a pane that does not exist', () => {
    const before = layout([pane('p0', [t('A')], 0)])
    expect(paneReducer(before, { type: 'moveMany', sessionIds: [], to: { pane: 0, index: 0 } })).toBe(before)
    expect(paneReducer(before, { type: 'moveMany', sessionIds: ['ZZ'], to: { pane: 0, index: 0 } })).toBe(before)
    expect(paneReducer(before, { type: 'moveMany', sessionIds: ['A'], to: { pane: 5, index: 0 } })).toBe(before)
  })
})

describe('rekey — a placeholder id became real', () => {
  it('rewrites the id in every pane and every slot, without moving anything', () => {
    // The placeholder named no conversation and is ceasing to exist, so nothing keyed to it may be
    // left behind. Two wrongs excluded: touching only the focused pane, and relocating the tab.
    const before = layout([pane('p0', [t('A'), t('PH'), t('C')], 1), pane('p1', [t('PH'), t('D')], 0)], 0)
    const after = step(before, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('S1'), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
    expect(after.panes[1].tabs).toEqual([t('S1'), t('D')])
    expect(after.panes[1].activeIndex).toBe(0)
  })

  it('drops the placeholder tab when the real id is already open here — placeholder AFTER', () => {
    // Separated ids on purpose. "Drop the placeholder's tab" (→ A,S1,B,C, active 1) and "keep the
    // placeholder's slot and drop the resident" (→ A,B,S1,C, active 2) are different arrays only
    // because S1 and PH are not adjacent.
    const before = layout([pane('p0', [t('A'), t('S1'), t('B'), t('PH'), t('C')], 3)])
    const after = step(before, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('S1'), t('B'), t('C')])
    expect(after.panes[0].activeIndex).toBe(1)
    expect(activeTabId(after)).toBe('S1')
  })

  it('drops the placeholder tab when the real id is already open here — placeholder BEFORE', () => {
    // The mirror direction, which is what pins the index arithmetic: the survivor's index shifts down
    // by one here and not in the case above.
    const before = layout([pane('p0', [t('A'), t('PH'), t('B'), t('S1'), t('C')], 1)])
    const after = step(before, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('B'), t('S1'), t('C')])
    expect(after.panes[0].activeIndex).toBe(2)
    expect(activeTabId(after)).toBe('S1')
  })

  it('keeps the selection put when the dropped placeholder was not the active tab', () => {
    const before = layout([pane('p0', [t('A'), t('S1'), t('B'), t('PH'), t('C')], 4)])
    const after = step(before, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(after.panes[0].tabs).toEqual([t('A'), t('S1'), t('B'), t('C')])
    expect(activeTabId(after)).toBe('C')
  })

  it('is a no-op when the ids match or the old id is not open', () => {
    const before = layout([pane('p0', [t('A'), t('PH')], 1)])
    expect(paneReducer(before, { type: 'rekey', from: 'PH', to: 'PH' })).toBe(before)
    expect(paneReducer(before, { type: 'rekey', from: 'ZZ', to: 'S1' })).toBe(before)
  })

  it('drops the placeholder when the real id is open in the OTHER pane', () => {
    // The hole a per-pane collision check left. Renaming here would have produced two tabs for one
    // conversation, one in each pane — which is precisely the state one-tab-per-conversation exists to
    // prevent, arrived at by a route that never went through `open`.
    const before = layout([pane('p0', [t('A'), t('PH')], 1), pane('p1', [t('S1')], 0)], 0)
    const after = step(before, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(after.panes[0].tabs).toEqual([t('A')])
    expect(after.panes[1].tabs).toEqual([t('S1')])
    const all = after.panes.flatMap((p) => p.tabs.map((x) => x.sessionId))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('retarget — a live terminal moved to another real conversation', () => {
  it('moves only the tab the user is standing on', () => {
    // Both ids name durable conversations, so an INACTIVE tab on the old id is a still-correct view
    // of a conversation that has not gone anywhere. Two wrongs excluded: rewriting both panes, and
    // rewriting the other pane's inactive tab on the same id.
    const before = layout([pane('p0', [t('S1'), t('X')], 0), pane('p1', [t('Y'), t('S1'), t('Z')], 1)], 1)
    const after = step(before, { type: 'retarget', from: 'S1', to: 'S2' })
    expect(after.panes[0].tabs).toEqual([t('S1'), t('X')])
    expect(after.panes[1].tabs).toEqual([t('Y'), t('S2'), t('Z')])
    expect(after.panes[1].activeIndex).toBe(1)
  })

  it('does nothing when the old id is open but NOT the active tab', () => {
    // The load-bearing guard. Relaxing it to "any tab holding the old id" would relabel a tab the
    // user never navigated to, naming a conversation that terminal is not running.
    const before = layout([pane('p0', [t('S1'), t('X')], 1)])
    expect(paneReducer(before, { type: 'retarget', from: 'S1', to: 'S2' })).toBe(before)
  })

  it('does nothing when the terminal is in the unfocused pane', () => {
    // Mirrors the navigation history: the selection follows the terminal only when the user is
    // actually looking at it.
    const before = layout([pane('p0', [t('S1')], 0), pane('p1', [t('Q')], 0)], 1)
    expect(paneReducer(before, { type: 'retarget', from: 'S1', to: 'S2' })).toBe(before)
  })

  it('activates an existing tab for the new id rather than creating a duplicate', () => {
    // The old tab stays: its conversation still exists, and only the terminal moved.
    const before = layout([pane('p0', [t('S1'), t('W'), t('S2')], 0)])
    const after = step(before, { type: 'retarget', from: 'S1', to: 'S2' })
    expect(after.panes[0].tabs).toEqual([t('S1'), t('W'), t('S2')])
    expect(after.panes[0].activeIndex).toBe(2)
    expect(activeTabId(after)).toBe('S2')
  })

  it('is a no-op when the ids match', () => {
    const before = layout([pane('p0', [t('S1')], 0)])
    expect(paneReducer(before, { type: 'retarget', from: 'S1', to: 'S1' })).toBe(before)
  })

  it('follows an existing tab for the new id into the OTHER pane', () => {
    // Same hole as rekey's, by the same route: the collision check looked only at the focused pane, so
    // this renamed p0's tab onto an id p1 already held. Asserted on the whole window, and on focus
    // moving — the conversation the terminal is now running is over there, so that is where the user
    // has to end up for the selection to keep meaning what it says.
    const before = layout([pane('p0', [t('S1')], 0), pane('p1', [t('S2')], 0)], 0)
    const after = step(before, { type: 'retarget', from: 'S1', to: 'S2' })
    expect(after.panes[0].tabs).toEqual([t('S1')])
    expect(after.panes[1].tabs).toEqual([t('S2')])
    expect(after.focusIndex).toBe(1)
    expect(activeTabId(after)).toBe('S2')
    const all = after.panes.flatMap((p) => p.tabs.map((x) => x.sessionId))
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('collapseToSingle — the feature switched off', () => {
  it('keeps exactly what is on screen, as a preview tab, in the pane the user was in', () => {
    // The surviving pane is the FOCUSED one, so the terminals most likely to be live and visible keep
    // their home and are not remounted. Everything else goes: with tabs off there is one slot and the
    // next open replaces it, which is the pre-tabs behaviour exactly.
    const before = layout([pane('p0', [t('A'), t('B')], 1), pane('p1', [t('C'), t('D')], 0)], 1)
    const after = step(before, { type: 'collapseToSingle' })
    expect(after).toEqual({
      panes: [{ id: 'p1', tabs: [t('C', true)], activeIndex: 0 }],
      focusIndex: 0,
      splitFraction: SPLIT_LIMITS.default
    })
    expect(activeTabId(after)).toBe('C')
  })

  it('collapses to an empty pane when nothing was selected', () => {
    const before = layout([pane('p0', [], -1), pane('p1', [t('C')], 0)], 0)
    const after = step(before, { type: 'collapseToSingle' })
    expect(after.panes).toEqual([{ id: 'p0', tabs: [], activeIndex: -1 }])
    expect(activeTabId(after)).toBeNull()
  })
})

describe('tab traversal', () => {
  const split = layout([pane('p0', [t('A'), t('B')], 1), pane('p1', [t('C'), t('D')], 0)], 0)

  it('tabSequence reads left pane then right pane', () => {
    expect(tabSequence(split)).toEqual([
      { pane: 0, index: 0 },
      { pane: 0, index: 1 },
      { pane: 1, index: 0 },
      { pane: 1, index: 1 }
    ])
  })

  it('stepping forward off the end of one strip continues into the other pane', () => {
    // Clamping instead would return { pane: 0, index: 1 } and the chord would go dead at the seam.
    expect(stepTab(split, 1)).toEqual({ pane: 1, index: 0 })
  })

  it('stepping backward off the start of the right pane lands on the left pane’s last tab', () => {
    const focusRight = { ...split, focusIndex: 1 }
    expect(stepTab(focusRight, -1)).toEqual({ pane: 0, index: 1 })
  })

  it('wraps at both ends of the whole window', () => {
    // Deliberately unlike the rail, which clamps: a strip holds a handful of tabs and a next/previous
    // that dies at an edge reads as broken. The two rules are independent.
    const last = { ...split, focusIndex: 1, panes: [split.panes[0], { ...split.panes[1], activeIndex: 1 }] }
    expect(stepTab(last, 1)).toEqual({ pane: 0, index: 0 })
    const first = { ...split, focusIndex: 0, panes: [{ ...split.panes[0], activeIndex: 0 }, split.panes[1]] }
    expect(stepTab(first, -1)).toEqual({ pane: 1, index: 1 })
  })

  it('steps from an empty focused pane to the first or last tab in the window', () => {
    const emptyLeft = layout([pane('p0', [], -1), pane('p1', [t('C'), t('D')], 0)], 0)
    expect(stepTab(emptyLeft, 1)).toEqual({ pane: 1, index: 0 })
    expect(stepTab(emptyLeft, -1)).toEqual({ pane: 1, index: 1 })
  })

  it('returns null only when the window holds no tabs at all', () => {
    expect(stepTab(initialLayout('p0'), 1)).toBeNull()
    expect(stepTab(initialLayout('p0'), -1)).toBeNull()
  })
})

describe('readers', () => {
  const split = layout([pane('p0', [t('A'), t('B')], 1), pane('p1', [t('C'), t('B')], 0)], 1)

  it('activeTabId reads the focused pane, not the first one', () => {
    expect(activeTabId(split)).toBe('C')
    expect(activeTabId({ ...split, focusIndex: 0 })).toBe('B')
  })

  it('openSessionIds unions both panes', () => {
    expect([...openSessionIds(split)].sort()).toEqual(['A', 'B', 'C'])
  })

  it('locateTab searches panes left to right', () => {
    expect(locateTab(split, 'B')).toEqual({ pane: 0, index: 1 })
    expect(locateTab(split, 'C')).toEqual({ pane: 1, index: 0 })
    expect(locateTab(split, 'nope')).toBeNull()
  })
})
