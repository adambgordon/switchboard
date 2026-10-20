/**
 * Reordering and membership for ordered id lists — the pinned list above all, and the live-session
 * list.
 *
 * Its own module rather than an export from `usePins`, so the unit tests can reach it without pulling
 * a React hook — and, more to the point, without pulling that hook's browser globals into the node
 * tsconfig, which has no DOM. (`localStorage` alone compiles there because @types/node declares it;
 * `window` does not, so any `window` reference in that file breaks the build for every test that
 * imports it, whether it uses the hook or not.)
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

/**
 * `moveBetween` for several items at once — a dragged group. They land contiguous, directly above
 * `lowerId` (or directly below `higherId` when dropped last), in the order they already had in
 * `order`; every other item keeps its relative order. Items not in `order` are ignored.
 *
 * Returns the SAME array when nothing moves.
 */
export function moveManyBetween<T>(order: T[], ids: readonly T[], higherId: T | null, lowerId: T | null): T[] {
  const moving = order.filter((x) => ids.includes(x))
  const rest = order.filter((x) => !ids.includes(x))
  let at: number
  if (lowerId !== null && rest.includes(lowerId)) at = rest.indexOf(lowerId)
  else if (higherId !== null && rest.includes(higherId)) at = rest.indexOf(higherId) + 1
  else return order
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
  return next.every((x, i) => x === order[i]) ? order : next
}

/**
 * The pin list with several conversations pinned or unpinned at once. Pinning appends the ones not
 * already pinned, in the order given — the order they show in — as one pin at a time would; unpinning
 * removes them. A SET, never a toggle: a pin that is already in the state asked for is left alone.
 *
 * Returns the SAME array when nothing changes, so a caller can skip the write.
 */
export function withPins(order: string[], ids: readonly string[], pinned: boolean): string[] {
  if (pinned) {
    const add = ids.filter((id, i) => !order.includes(id) && ids.indexOf(id) === i)
    return add.length === 0 ? order : [...order, ...add]
  }
  const drop = new Set(ids)
  return order.some((id) => drop.has(id)) ? order.filter((id) => !drop.has(id)) : order
}
