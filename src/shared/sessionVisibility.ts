import type { ConversationIndexSnapshot, PersistedTabLayout, TabDragPayload } from './types'
import { sanitizeTabLayout } from './tabWorkspace'

export const EMPTY_SESSION_INDEX: ConversationIndexSnapshot = { groups: [], hiddenSessionIds: [] }

/** Delegation is intrinsic to a thread; a later failed read cannot revoke that evidence. */
export function retainHiddenSessions(
  snapshot: ConversationIndexSnapshot,
  previouslyHidden: ReadonlySet<string>
): ConversationIndexSnapshot {
  const hidden = new Set([...previouslyHidden, ...snapshot.hiddenSessionIds])
  const groups = snapshot.groups.flatMap((group) => {
    const conversations = group.conversations.filter((meta) => !hidden.has(meta.sessionId))
    if (conversations.length === 0) return []
    if (conversations.length === group.conversations.length) return [group]
    return [{ ...group, conversations, latestMtime: Math.max(...conversations.map((meta) => meta.mtime)) }]
  }).sort((a, b) => b.latestMtime - a.latestMtime)
  return { groups, hiddenSessionIds: [...hidden].sort() }
}

export function visibleTabLayout(
  layout: PersistedTabLayout | null,
  hidden: ReadonlySet<string>
): PersistedTabLayout | null {
  if (!layout || hidden.size === 0) return layout
  return sanitizeTabLayout({ panes: layout.panes.map((pane) => {
    const sessionIds = pane.sessionIds.filter((id) => !hidden.has(id))
    const active = pane.activeSessionId
    const activeSessionId = active === null || sessionIds.includes(active)
      ? active
      : sessionIds[Math.min(pane.sessionIds.indexOf(active), sessionIds.length - 1)] ?? null
    return { sessionIds, activeSessionId }
  }) })
}

export function visibleTabDrag(
  payload: TabDragPayload,
  hidden: ReadonlySet<string>
): TabDragPayload | null {
  const sessionIds = payload.sessionIds.filter((id) => !hidden.has(id))
  if (sessionIds.length === 0) return null
  return {
    sessionIds,
    activeSessionId: sessionIds.includes(payload.activeSessionId) ? payload.activeSessionId : sessionIds[0]
  }
}
