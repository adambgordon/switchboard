import { describe, expect, it } from 'vitest'
import {
  NO_SELECTION,
  actionTargets,
  extendSelection,
  hasGroup,
  pruneSelection,
  selectOnly,
  toggleSelected,
  type TabSelection
} from '../src/renderer/lib/tabSelection'

/**
 * Selecting several tabs at once.
 *
 * The rules that matter are the ones a person only discovers by doing something awkward: ⌘-clicking a
 * second tab when one was already active, ⇧-clicking twice to correct a range, closing a tab out from
 * under a group. Each is asserted against a fixture where the plausible wrong answer is visibly
 * different, because most of these have a wrong answer that looks fine in the easy case.
 */

const sel = (pane: number, ids: string[], anchor: string | null): TabSelection => ({
  pane,
  ids: new Set(ids),
  anchor
})

const ORDER = ['A', 'B', 'C', 'D', 'E']

describe('hasGroup', () => {
  it('is false for an empty selection and for a single tab', () => {
    // One tab is not a group: every command already knows how to act on the active tab alone.
    expect(hasGroup(NO_SELECTION, 0)).toBe(false)
    expect(hasGroup(sel(0, ['A'], 'A'), 0)).toBe(false)
  })

  it('is true for two or more, but only in the pane that owns them', () => {
    const s = sel(0, ['A', 'B'], 'A')
    expect(hasGroup(s, 0)).toBe(true)
    expect(hasGroup(s, 1)).toBe(false)
  })
})

describe('actionTargets', () => {
  it('is just the invoked tab when there is no group', () => {
    expect(actionTargets(NO_SELECTION, 0, 'C')).toEqual(['C'])
  })

  it('is the whole group when the invoked tab belongs to it', () => {
    expect(actionTargets(sel(0, ['A', 'B'], 'A'), 0, 'A').sort()).toEqual(['A', 'B'])
  })

  it('is just the invoked tab when it is OUTSIDE the group', () => {
    // Right-clicking a tab that is not part of the selection acts on that tab — the alternative is
    // closing five conversations because the pointer was a few pixels off.
    expect(actionTargets(sel(0, ['A', 'B'], 'A'), 0, 'E')).toEqual(['E'])
  })

  it('is just the invoked tab when the group belongs to the other pane', () => {
    expect(actionTargets(sel(1, ['A', 'B'], 'A'), 0, 'A')).toEqual(['A'])
  })
})

describe('toggleSelected — ⌘-click', () => {
  it('selects BOTH when starting from a single active tab', () => {
    // The active tab was already the implicit selection, so ⌘-clicking a second must not look like it
    // deselected the first.
    const after = toggleSelected(NO_SELECTION, 0, 'A', 'C')
    expect([...after.ids].sort()).toEqual(['A', 'C'])
    expect(after.anchor).toBe('C')
  })

  it('does not duplicate when the active tab is the one clicked', () => {
    const after = toggleSelected(NO_SELECTION, 0, 'A', 'A')
    expect([...after.ids]).toEqual(['A'])
  })

  it('adds to an existing group', () => {
    const after = toggleSelected(sel(0, ['A', 'B'], 'B'), 0, 'B', 'D')
    expect([...after.ids].sort()).toEqual(['A', 'B', 'D'])
    expect(after.anchor).toBe('D')
  })

  it('removes one that is already in the group, without seeding the active tab again', () => {
    // The seeding branch must be reachable ONLY when starting fresh. If it also ran here, removing a
    // tab could silently re-add the active one and the group would never shrink.
    const after = toggleSelected(sel(0, ['A', 'B', 'D'], 'D'), 0, 'A', 'B')
    expect([...after.ids].sort()).toEqual(['A', 'D'])
  })

  it('clears entirely when the last one is removed', () => {
    expect(toggleSelected(sel(0, ['A'], 'A'), 0, 'A', 'A')).toEqual(NO_SELECTION)
  })

  it('moves the anchor to a survivor when the anchor itself is removed', () => {
    // Otherwise the next ⇧-click has no origin and silently does nothing.
    const after = toggleSelected(sel(0, ['A', 'B'], 'B'), 0, 'A', 'B')
    expect([...after.ids]).toEqual(['A'])
    expect(after.anchor).toBe('A')
  })

  it('starts fresh when the click lands in the OTHER pane', () => {
    // A selection belongs to one pane, so this is a new selection rather than an extension across.
    const after = toggleSelected(sel(0, ['A', 'B'], 'B'), 1, 'X', 'Y')
    expect(after.pane).toBe(1)
    expect([...after.ids].sort()).toEqual(['X', 'Y'])
  })
})

describe('extendSelection — ⇧-click', () => {
  it('selects the run from the anchor, in either direction', () => {
    expect([...extendSelection(sel(0, ['B'], 'B'), 0, ORDER, 'D').ids]).toEqual(['B', 'C', 'D'])
    // Backwards gives the same run — the anchor is an end, not a start.
    expect([...extendSelection(sel(0, ['D'], 'D'), 0, ORDER, 'B').ids]).toEqual(['B', 'C', 'D'])
  })

  it('REPLACES the previous range rather than growing it', () => {
    // What makes a mis-aimed ⇧-click correctable by another. Growing would make every shift-click
    // permanent, which is why the anchor also has to stay put (asserted next).
    const first = extendSelection(sel(0, ['B'], 'B'), 0, ORDER, 'E')
    const second = extendSelection(first, 0, ORDER, 'C')
    expect([...second.ids]).toEqual(['B', 'C'])
  })

  it('keeps the anchor where it was', () => {
    const after = extendSelection(sel(0, ['B'], 'B'), 0, ORDER, 'E')
    expect(after.anchor).toBe('B')
  })

  it('starts a new anchor when there is none, or the old one is gone', () => {
    expect(extendSelection(NO_SELECTION, 0, ORDER, 'C')).toEqual(sel(0, ['C'], 'C'))
    // Anchor names a tab that has since closed.
    expect(extendSelection(sel(0, ['Z'], 'Z'), 0, ORDER, 'C')).toEqual(sel(0, ['C'], 'C'))
  })

  it('ignores a click on a tab that is not in this pane', () => {
    const before = sel(0, ['B'], 'B')
    expect(extendSelection(before, 0, ORDER, 'ZZ')).toBe(before)
  })

  it('does not carry an anchor across panes', () => {
    // The anchor belongs to pane 0's order; reusing it against pane 1's would select a run between two
    // unrelated positions.
    //
    // The fixture shares the anchor id with the other pane ON PURPOSE — reachable by dragging the
    // anchored tab across. With disjoint ids the leak is invisible: a stale anchor is simply not found
    // in the other pane's order, so it falls into the same no-anchor branch and both behaviours return
    // an identical result. The id has to exist over there for the two to differ at all.
    const after = extendSelection(sel(0, ['B'], 'B'), 1, ['X', 'B', 'Y', 'Z'], 'Z')
    expect([...after.ids]).toEqual(['Z'])
    expect(after.anchor).toBe('Z')
  })
})

describe('selectOnly — a plain click', () => {
  it('drops any group', () => {
    // The gesture that means "just this one", and the way out of a selection.
    expect(selectOnly()).toEqual(NO_SELECTION)
  })
})

describe('pruneSelection', () => {
  it('returns the input unchanged when everything is still there', () => {
    // By identity: this runs after every layout change, so an unchanged result must not re-render.
    const before = sel(0, ['B', 'C'], 'B')
    expect(pruneSelection(before, [ORDER])).toBe(before)
  })

  it('leaves an empty selection alone', () => {
    expect(pruneSelection(NO_SELECTION, [ORDER])).toBe(NO_SELECTION)
  })

  it('drops ids the pane no longer holds', () => {
    const after = pruneSelection(sel(0, ['B', 'C', 'ZZ'], 'B'), [ORDER])
    expect([...after.ids].sort()).toEqual(['B', 'C'])
  })

  it('clears when the pane itself is gone', () => {
    // After an unsplit, a selection in pane 1 refers to a pane that no longer exists.
    expect(pruneSelection(sel(1, ['B', 'C'], 'B'), [ORDER])).toEqual(NO_SELECTION)
  })

  it('clears when nothing survives', () => {
    expect(pruneSelection(sel(0, ['ZZ', 'YY'], 'ZZ'), [ORDER])).toEqual(NO_SELECTION)
  })

  it('keeps a lone survivor, and its anchor', () => {
    // Not a group any more, and nothing draws it as one — but the anchor is what a subsequent ⇧-click
    // extends from, so discarding it would quietly cost the user their place.
    const after = pruneSelection(sel(0, ['B', 'ZZ'], 'B'), [ORDER])
    expect([...after.ids]).toEqual(['B'])
    expect(after.anchor).toBe('B')
  })

  it('drops an anchor that did not survive', () => {
    const after = pruneSelection(sel(0, ['B', 'C', 'ZZ'], 'ZZ'), [ORDER])
    expect(after.anchor).toBe(null)
  })

  it('prunes against the selection OWN pane, not the first one', () => {
    // Two panes, and the selection is in the second. Checking pane 0's tabs would discard everything.
    const after = pruneSelection(sel(1, ['Y', 'Z'], 'Y'), [ORDER, ['X', 'Y', 'Z']])
    expect([...after.ids].sort()).toEqual(['Y', 'Z'])
  })
})
