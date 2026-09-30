/**
 * The window's history of closed tabs, behind ⇧⌘T.
 *
 * One entry per close the user made, however many tabs it took — ⌘W on one tab, "Close 3 tabs" on a
 * selection, "Close other tabs" — so a reopen brings back exactly what one close removed, and the
 * next reopen reaches one close further back. Each tab remembers where it stood, so it can return to
 * the same slot in the same pane, or to the same side of a split that has since collapsed.
 *
 * Kept per window and in memory only: a conversation is not lost by closing its tab, and the rail
 * still reaches it, so this is a convenience for undoing a close, not a record worth persisting.
 */

import type { PaneLayout } from './paneModel'
import { isChooserTab } from './chooserTab'

/** Which side of the window a tab was on: one of two panes, or the only one. */
export type ClosedSide = 'left' | 'right' | 'only'

export interface ClosedTab {
  sessionId: string
  /** The pane it was in. Pane ids are never reused, so a match means the same pane. */
  paneId: string
  side: ClosedSide
  /** Its slot in that pane's strip. */
  index: number
}

export interface ClosedGroup {
  /** In strip order. */
  tabs: ClosedTab[]
  /** The one to show on reopening: the tab that was showing, if the close took it. */
  activeId: string
}

export const CLOSED_TABS_CAP = 25

/**
 * Record what closing `ids` is about to remove. Read from the layout BEFORE the close lands — after
 * it, the positions are gone. Null when nothing recordable is among them: a chooser stands for no
 * conversation, so there is nothing to reopen.
 */
export function captureClosed(layout: PaneLayout, ids: readonly string[]): ClosedGroup | null {
  const closing = new Set(ids)
  const tabs: ClosedTab[] = []
  layout.panes.forEach((pane, p) => {
    const side: ClosedSide = layout.panes.length === 1 ? 'only' : p === 0 ? 'left' : 'right'
    pane.tabs.forEach((tab, index) => {
      if (!closing.has(tab.sessionId) || isChooserTab(tab.sessionId)) return
      tabs.push({ sessionId: tab.sessionId, paneId: pane.id, side, index })
    })
  })
  if (tabs.length === 0) return null
  // The focused pane's showing tab first, so a group spanning both panes reopens onto what the user
  // was looking at rather than the other pane's.
  const shownIn = (p: number): string | undefined => {
    const pane = layout.panes[p]
    return pane.tabs[pane.activeIndex]?.sessionId
  }
  const activeId = [layout.focusIndex, ...layout.panes.keys()]
    .map(shownIn)
    .find((id) => id !== undefined && tabs.some((t) => t.sessionId === id))
  return { tabs, activeId: activeId ?? tabs[0].sessionId }
}

/** Newest last; the oldest entries fall off past the cap. */
export function pushClosed(
  stack: readonly ClosedGroup[],
  group: ClosedGroup,
  cap: number = CLOSED_TABS_CAP
): ClosedGroup[] {
  const next = [...stack, group]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * The history with a placeholder's id replaced by the conversation it just bound to, so a closed
 * unlinked terminal that kept running can still be reopened. Initial binds only: a correction's old id
 * is a real conversation of its own, and its closes stay its own.
 */
export function rekeyClosed(stack: readonly ClosedGroup[], oldId: string, newId: string): ClosedGroup[] {
  return stack.map((g) => ({
    tabs: g.tabs.map((t) => (t.sessionId === oldId ? { ...t, sessionId: newId } : t)),
    activeId: g.activeId === oldId ? newId : g.activeId
  }))
}

/**
 * The newest entry that still has something to reopen, and the history left once it is taken.
 *
 * A tab that can no longer come back — its conversation already has a tab, is hidden, or is gone — is
 * dropped from its entry, and an entry left with nothing is discarded on the way past, so one ⇧⌘T
 * always reopens something while anything is reopenable. The active tab falls to the first survivor
 * when it was among those dropped.
 */
export function takeReopenable(
  stack: readonly ClosedGroup[],
  canReopen: (sessionId: string) => boolean
): { group: ClosedGroup | null; rest: ClosedGroup[] } {
  for (let i = stack.length - 1; i >= 0; i--) {
    const tabs = stack[i].tabs.filter((t) => canReopen(t.sessionId))
    if (tabs.length === 0) continue
    const activeId = tabs.some((t) => t.sessionId === stack[i].activeId) ? stack[i].activeId : tabs[0].sessionId
    return { group: { tabs, activeId }, rest: stack.slice(0, i) }
  }
  return { group: null, rest: [] }
}
