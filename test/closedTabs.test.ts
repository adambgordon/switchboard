import { describe, expect, it } from 'vitest'
import {
  CLOSED_TABS_CAP,
  captureClosed,
  pushClosed,
  rekeyClosed,
  takeReopenable,
  type ClosedGroup
} from '../src/renderer/lib/closedTabs'
import { chooserTabId } from '../src/renderer/lib/chooserTab'
import { SPLIT_LIMITS, type Pane, type PaneLayout } from '../src/renderer/lib/paneModel'

/**
 * The history behind ⇧⌘T: what one close recorded, and which entry a reopen takes. Where the tabs
 * then land is the reducer's `reopen`, tested in paneModel.
 */

const pane = (id: string, ids: string[], activeIndex: number): Pane => ({
  id,
  tabs: ids.map((sessionId) => ({ sessionId, preview: false })),
  activeIndex
})
const layout = (panes: Pane[], focusIndex = 0): PaneLayout => ({
  panes,
  focusIndex,
  splitFraction: SPLIT_LIMITS.default
})
const group = (ids: string[], activeId = ids[0]): ClosedGroup => ({
  tabs: ids.map((sessionId, index) => ({ sessionId, paneId: 'p0', side: 'only', index })),
  activeId
})

describe('captureClosed', () => {
  it('records each tab’s pane, side and slot, in strip order whatever order the ids came in', () => {
    // The focused pane shows A, which stays; D is the showing tab the close took.
    const l = layout([pane('p0', ['A', 'B', 'C'], 0), pane('p3', ['D', 'E', 'F'], 0)])
    expect(captureClosed(l, ['F', 'B', 'D'])).toEqual({
      tabs: [
        { sessionId: 'B', paneId: 'p0', side: 'left', index: 1 },
        { sessionId: 'D', paneId: 'p3', side: 'right', index: 0 },
        { sessionId: 'F', paneId: 'p3', side: 'right', index: 2 }
      ],
      activeId: 'D'
    })
  })

  it('a single pane is neither side, so a later split does not decide where it goes', () => {
    expect(captureClosed(layout([pane('p0', ['A', 'B'], 0)]), ['B'])?.tabs).toEqual([
      { sessionId: 'B', paneId: 'p0', side: 'only', index: 1 }
    ])
  })

  it('shows the focused pane’s tab over the other pane’s when the close took both', () => {
    // Both panes' showing tabs are in the close; focus is on the RIGHT, so taking the first pane's
    // (or the first tab) instead is visible.
    const l = layout([pane('p0', ['A', 'B'], 1), pane('p1', ['C', 'D'], 1)], 1)
    expect(captureClosed(l, ['A', 'B', 'C', 'D'])?.activeId).toBe('D')
  })

  it('falls back to the first closed tab when none of them was showing', () => {
    // "Close other tabs" on C: the closed ones are all in the background.
    const l = layout([pane('p0', ['A', 'B', 'C', 'D'], 2)])
    expect(captureClosed(l, ['A', 'B', 'D'])?.activeId).toBe('A')
  })

  it('records no chooser — it stands for no conversation — and nothing at all for a chooser alone', () => {
    const chooser = chooserTabId(1)
    const l = layout([pane('p0', ['A', chooser, 'B'], 1)])
    expect(captureClosed(l, ['A', chooser, 'B'])).toEqual({
      tabs: [
        { sessionId: 'A', paneId: 'p0', side: 'only', index: 0 },
        { sessionId: 'B', paneId: 'p0', side: 'only', index: 2 }
      ],
      activeId: 'A'
    })
    expect(captureClosed(l, [chooser])).toBeNull()
  })

  it('records nothing for ids with no tab', () => {
    expect(captureClosed(layout([pane('p0', ['A'], 0)]), ['Z'])).toBeNull()
  })
})

describe('pushClosed', () => {
  it('keeps the newest last and drops the oldest past the cap', () => {
    let stack: ClosedGroup[] = []
    for (let i = 0; i < CLOSED_TABS_CAP + 2; i++) stack = pushClosed(stack, group([`t${i}`]))
    expect(stack).toHaveLength(CLOSED_TABS_CAP)
    expect(stack[0].tabs[0].sessionId).toBe('t2')
    expect(stack[CLOSED_TABS_CAP - 1].tabs[0].sessionId).toBe(`t${CLOSED_TABS_CAP + 1}`)
  })

  it('honors a cap other than the default', () => {
    const stack = pushClosed(pushClosed(pushClosed([], group(['A'])), group(['B']), 2), group(['C']), 2)
    expect(stack.map((g) => g.tabs[0].sessionId)).toEqual(['B', 'C'])
  })
})

describe('rekeyClosed', () => {
  it('moves a closed placeholder, and its active mark, to the conversation it bound to', () => {
    const stack = [group(['a', 'ph'], 'ph'), group(['b']), group(['ph', 'c'], 'c')]
    expect(rekeyClosed(stack, 'ph', 'real')).toEqual([group(['a', 'real'], 'real'), group(['b']), group(['real', 'c'], 'c')])
  })
})

describe('takeReopenable', () => {
  const all = (): boolean => true

  it('takes the newest entry whole, and leaves the older ones for the next reopen', () => {
    const stack = [group(['A']), group(['B', 'C'], 'C'), group(['D'])]
    const first = takeReopenable(stack, all)
    expect(first.group).toEqual(group(['D']))
    const second = takeReopenable(first.rest, all)
    expect(second.group).toEqual(group(['B', 'C'], 'C'))
    expect(second.rest).toEqual([group(['A'])])
  })

  it('drops what cannot come back, keeping the rest of the entry and its slots', () => {
    const { group: g } = takeReopenable([group(['A', 'B', 'C'], 'C')], (id) => id !== 'B')
    expect(g).toEqual({
      tabs: [
        { sessionId: 'A', paneId: 'p0', side: 'only', index: 0 },
        { sessionId: 'C', paneId: 'p0', side: 'only', index: 2 }
      ],
      activeId: 'C'
    })
  })

  it('moves the active tab to the first survivor when it was the one dropped', () => {
    const { group: g } = takeReopenable([group(['A', 'B', 'C'], 'B')], (id) => id !== 'B')
    expect(g?.activeId).toBe('A')
  })

  it('discards an entry with nothing left and reopens the next one, in one go', () => {
    const stack = [group(['A']), group(['B']), group(['C'])]
    const { group: g, rest } = takeReopenable(stack, (id) => id !== 'C')
    expect(g).toEqual(group(['B']))
    // C's entry is gone for good, not left on top to block the next reopen.
    expect(rest).toEqual([group(['A'])])
  })

  it('empties the history when nothing in it can come back', () => {
    expect(takeReopenable([group(['A']), group(['B'])], () => false)).toEqual({ group: null, rest: [] })
    expect(takeReopenable([], all)).toEqual({ group: null, rest: [] })
  })
})
