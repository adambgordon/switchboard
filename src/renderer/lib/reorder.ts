/**
 * Move-one-item reorder, shared by the pinned list and the live-session list.
 *
 * Its own module rather than an export from `usePins`, so the unit tests can reach it without pulling
 * a React hook — and, more to the point, without pulling that hook's browser globals into the node
 * tsconfig, which has no DOM. (`localStorage` alone slipped past for a long while because @types/node
 * happens to declare it; `window` does not, so the first `window` reference in that file broke the
 * build for a test that never used it.)
 */

/** Returns the SAME array on a no-op, so callers can skip a write and a re-render by identity. */
export function reorderArray<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * Move `id` so it sits directly below `higherId` and directly above `lowerId` — the neighbors it was
 * dropped between, either null at an edge. The neighbors come from a SUBSET of `order` (one folder's
 * pins, drawn from the app-wide pin list), so they need not be adjacent in it; the item goes directly
 * above `lowerId`, or directly below `higherId` when dropped last, and every other item keeps its
 * relative order.
 *
 * Returns the SAME array when nothing moves.
 */
export function moveBetween<T>(order: T[], id: T, higherId: T | null, lowerId: T | null): T[] {
  const from = order.indexOf(id)
  if (from < 0) return order
  const rest = order.filter((x) => x !== id)
  let at: number
  if (lowerId !== null && rest.includes(lowerId)) at = rest.indexOf(lowerId)
  else if (higherId !== null && rest.includes(higherId)) at = rest.indexOf(higherId) + 1
  else return order
  if (at === from) return order
  rest.splice(at, 0, id)
  return rest
}
