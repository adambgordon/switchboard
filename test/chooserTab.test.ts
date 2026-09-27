import { describe, expect, it } from 'vitest'
import {
  chooserAgent,
  chooserTabId,
  isChooserTab,
  newConversationTarget,
  strayChoosers
} from '../src/renderer/lib/chooserTab'
import {
  SPLIT_LIMITS,
  openSessionIds,
  paneReducer,
  snapshotPaneLayout,
  type Pane,
  type PaneLayout,
  type Tab
} from '../src/renderer/lib/paneModel'

/**
 * The new-conversation chooser is a tab with a reserved id. These pin the reserved namespace, the two
 * decisions taken on it (what ⌘N does; which choosers a tabs-off window drops), and the readers that
 * must skip it. They also pin the two reducer actions the chooser reuses rather than adding its own —
 * opening after the active tab, and `rekey` turning it into the conversation started from it — because
 * the design rests on those behaving this way for a chooser id.
 */

const t = (sessionId: string, preview = false): Tab => ({ sessionId, preview })
const pane = (id: string, tabs: Tab[], activeIndex: number): Pane => ({ id, tabs, activeIndex })
const layout = (panes: Pane[], focusIndex = 0): PaneLayout => ({
  panes,
  focusIndex,
  splitFraction: SPLIT_LIMITS.default
})

// UUID-shaped, as every real session id and terminal placeholder is.
const A = '6f1c2b1e-0d8a-4c1e-9d55-1f0a9e3b7c21'
const B = '0b7e9c44-5a1f-4b2d-8e3c-7d6a5f4e3b2a'
const C = 'c3d2e1f0-a9b8-4c7d-8e6f-5a4b3c2d1e0f'
const X = chooserTabId(1)
const Y = chooserTabId(2)

describe('the reserved id', () => {
  it('names choosers and nothing a session id can be', () => {
    expect(isChooserTab(X)).toBe(true)
    expect(X).not.toBe(Y)
    for (const id of [A, B, C, '', 'chooser', 'xchooser:1']) expect(isChooserTab(id)).toBe(false)
  })
})

describe('newConversationTarget', () => {
  it('focuses the chooser the focused pane is standing on', () => {
    const l = layout([pane('p0', [t(A)], 0), pane('p1', [t(B), t(Y)], 1)], 1)
    expect(newConversationTarget(l)).toEqual({ kind: 'focus', id: Y })
  })

  it('opens a new one from anywhere else — a chooser elsewhere or unfocused does not count', () => {
    // The focused pane holds a chooser, but is showing a conversation; the other pane is standing on one.
    const l = layout([pane('p0', [t(X)], 0), pane('p1', [t(Y), t(B)], 1)], 1)
    expect(newConversationTarget(l)).toEqual({ kind: 'open' })
    // Nothing active — the welcome screen over a chooser tab.
    expect(newConversationTarget(layout([pane('p0', [t(X)], -1)]))).toEqual({ kind: 'open' })
  })
})

describe('chooserAgent', () => {
  it('keeps a pick that is launchable, whatever the default', () => {
    expect(chooserAgent('codex', ['claude', 'codex'], 'claude')).toBe('codex')
  })

  it('drops a pick that turned out not to be installed, for the default', () => {
    // Picked while both were assumed; only Codex is installed, and the default already follows that.
    expect(chooserAgent('claude', ['codex'], 'codex')).toBe('codex')
  })
})

describe('strayChoosers (tabs off)', () => {
  it('drops every chooser except the one on screen', () => {
    const l = layout([pane('p0', [t(X), t(A, true), t(Y)], 2)])
    expect(strayChoosers(l)).toEqual([X])
  })

  it('drops the chooser once something else is on screen', () => {
    // A click in the rail replaced the preview in place and activated it; the chooser beside it is gone
    // from view and cannot be reached without a strip.
    expect(strayChoosers(layout([pane('p0', [t(B, true), t(X)], 0)]))).toEqual([X])
    expect(strayChoosers(layout([pane('p0', [t(B, true)], 0)]))).toEqual([])
  })
})

describe('readers skip choosers', () => {
  it('openSessionIds reports conversations only', () => {
    const l = layout([pane('p0', [t(A), t(X)], 1), pane('p1', [t(Y), t(B)], 0)])
    expect([...openSessionIds(l)].sort()).toEqual([B, A].sort())
  })

  it('persists no chooser, restoring a pane standing on one onto the neighbor closing it selects', () => {
    const l = layout([
      // Mid-strip: its right neighbor slides into its slot.
      pane('p0', [t(A), t(X), t(B)], 1),
      // Last: the left neighbor.
      pane('p1', [t(C), t(Y)], 1)
    ])
    expect(snapshotPaneLayout(l)).toEqual({
      panes: [
        { sessionIds: [A, B], activeSessionId: B },
        { sessionIds: [C], activeSessionId: C }
      ]
    })
  })

  it('keeps an active conversation where it stands, and drops a pane holding only choosers', () => {
    const l = layout([pane('p0', [t(X), t(A), t(B)], 2), pane('p1', [t(Y)], 0)])
    expect(snapshotPaneLayout(l)).toEqual({ panes: [{ sessionIds: [A, B], activeSessionId: B }] })
    expect(snapshotPaneLayout(layout([pane('p0', [t(X)], 0)]))).toBeNull()
  })
})

describe('the reducer actions a chooser reuses', () => {
  it('opens after the active tab, sticky, beside a preview it must not replace', () => {
    // Tabs off keeps one preview tab; the chooser goes beside it so dismissing returns to it.
    const l = layout([pane('p0', [t(A), t(B, true), t(C)], 0)])
    expect(paneReducer(l, { type: 'open', sessionId: X, mode: 'persistent' }).panes[0]).toEqual(
      pane('p0', [t(A), t(X), t(B, true), t(C)], 1)
    )
  })

  it('rekey turns the chooser into its conversation in place, keeping which tab is shown', () => {
    const shown = layout([pane('p0', [t(A), t(X), t(B)], 1)])
    expect(paneReducer(shown, { type: 'rekey', from: X, to: C })).toEqual(
      layout([pane('p0', [t(A), t(C), t(B)], 1)])
    )
    // Started, then the user moved on while it spawned: it lands in the background.
    const moved = layout([pane('p0', [t(A), t(X), t(B)], 2)])
    expect(paneReducer(moved, { type: 'rekey', from: X, to: C })).toEqual(
      layout([pane('p0', [t(A), t(C), t(B)], 2)])
    )
  })

  it('closing a chooser and revealing its opener returns there, not to the neighbor that slid in', () => {
    const l = layout([pane('p0', [t(A), t(B), t(X), t(C)], 2)])
    const closed = paneReducer(l, { type: 'closeMany', sessionIds: [X] })
    expect(closed.panes[0].activeIndex).toBe(2) // C slid in — what a plain close shows
    const back = paneReducer(closed, { type: 'open', sessionId: B, mode: 'preview' })
    expect(back).toEqual(layout([pane('p0', [t(A), t(B), t(C)], 1)]))
  })
})
