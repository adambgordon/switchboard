/**
 * The merge rules for the per-conversation marker maps (`seenAt`, `unreadAt`).
 *
 * Extracted from `useSeen` for two reasons. The rules themselves have edge cases worth pinning — a
 * marker must never move backward, and a rekey must not resurrect the old id. And every function here
 * returns its INPUT BY IDENTITY when nothing changes, which is what lets the caller apply a mutation
 * against what is on disk and then tell, in one comparison, whether anything needs writing or
 * re-rendering.
 *
 * That identity contract is the load-bearing part. These maps are shared by every window through one
 * localStorage area, and the store is read-modify-WRITTEN rather than overwritten from memory: each
 * mutation re-reads what is there, folds in one change, and puts it back. So a window's write can no
 * longer revert changes it never knew about — which is exactly what a whole-map write from stale
 * in-memory state did.
 */

/** sessionId -> ms epoch. */
export type Marks = Record<string, number>

/**
 * Advance a marker to `ts`, never backward.
 *
 * Forward-only is not an optimisation: `seenAt` is compared against a turn's end time to decide
 * whether a finished turn has been looked at, so moving one backward would make an already-seen
 * conversation start reporting itself unread again.
 */
export function advanceMark(prev: Marks, id: string, ts: number): Marks {
  if ((prev[id] ?? 0) >= ts) return prev
  return { ...prev, [id]: ts }
}

/** Set a marker to `ts` unconditionally — for a manual mark, where the user's latest act wins. */
export function setMark(prev: Marks, id: string, ts: number): Marks {
  if (prev[id] === ts) return prev
  return { ...prev, [id]: ts }
}

/** Remove a marker. */
export function clearMark(prev: Marks, id: string): Marks {
  if (!(id in prev)) return prev
  const next = { ...prev }
  delete next[id]
  return next
}

/**
 * Move a marker from `oldId` to `newId` — a Codex session's placeholder id becoming its real one.
 *
 * The old key is deleted, not merely copied from: leaving it behind would keep a marker for an id that
 * names nothing, and those accumulate for the lifetime of the store. When the new id already holds a
 * marker the LATER of the two wins, since both describe the same conversation.
 */
export function rekeyMark(prev: Marks, oldId: string, newId: string): Marks {
  if (oldId === newId || !(oldId in prev)) return prev
  const next = { ...prev }
  delete next[oldId]
  const existing = prev[newId]
  next[newId] = existing === undefined ? prev[oldId] : Math.max(existing, prev[oldId])
  return next
}
