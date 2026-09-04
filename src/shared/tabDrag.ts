import type { TabDragPayload } from './types'

/** Build the drag payload in source-strip order, regardless of selection insertion order. */
export function makeTabDragPayload(
  order: string[],
  targets: string[],
  activeSessionId: string
): TabDragPayload {
  const carried = new Set(targets)
  carried.add(activeSessionId)
  const sessionIds = order.filter((id) => carried.has(id))
  return {
    sessionIds: sessionIds.includes(activeSessionId) ? sessionIds : [activeSessionId, ...sessionIds],
    activeSessionId
  }
}

/** Validate an IPC payload and remove duplicate ids without changing their order. */
export function parseTabDragPayload(value: unknown): TabDragPayload | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { sessionIds?: unknown; activeSessionId?: unknown }
  if (!Array.isArray(raw.sessionIds) || typeof raw.activeSessionId !== 'string') return null
  const sessionIds = [
    ...new Set(raw.sessionIds.filter((id): id is string => typeof id === 'string' && !!id))
  ]
  if (!raw.activeSessionId || !sessionIds.includes(raw.activeSessionId)) return null
  return { sessionIds, activeSessionId: raw.activeSessionId }
}
