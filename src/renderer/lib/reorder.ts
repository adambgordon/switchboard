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
