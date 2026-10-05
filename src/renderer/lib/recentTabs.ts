/**
 * The conversations this window has shown, most recent first — what closing the active tab returns
 * to, instead of whichever neighbor slid into its slot.
 *
 * Per window and memory-only, and deliberately not the Back/Forward history: that log is app-wide,
 * keeps Forward stops that are not "previous" at all, and lives across a process boundary, while a
 * close has to settle its next tab in the same render. One conversation holds one tab app-wide, so
 * filtering this list by "still a tab in the pane that closed" is all the scoping it needs.
 */

/** Plenty to outlast any strip of tabs; the bound only keeps a long session from growing it. */
export const RECENT_CAP = 64

/** Move `id` to the front. Returns the input by identity when it is already there. */
export function touchRecent(list: readonly string[], id: string): readonly string[] {
  if (list[0] === id) return list
  const next = [id, ...list.filter((x) => x !== id)]
  return next.length > RECENT_CAP ? next.slice(0, RECENT_CAP) : next
}

/** A placeholder id became real: the entry keeps its place under the new id. */
export function rekeyRecent(list: readonly string[], from: string, to: string): readonly string[] {
  if (from === to || !list.includes(from)) return list
  const out: string[] = []
  for (const id of list) {
    const next = id === from ? to : id
    if (!out.includes(next)) out.push(next)
  }
  return out
}
