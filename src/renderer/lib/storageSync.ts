/**
 * Whether a `storage` event from another window should make this one re-read its value.
 *
 * Pure, and separate from the hook, because this predicate is the whole correctness content of
 * cross-window preference sync and inside an effect no test can reach it. Both halves are
 * load-bearing in opposite directions:
 *
 * - `null` is what the StorageEvent spec reports for `localStorage.clear()` — no single key
 *   changed, everything did. Ignoring it leaves this window rendering values that no longer exist.
 * - The key comparison is what keeps an unrelated preference's write from re-reading and
 *   re-rendering every other hook in every open window, on a store that several of them poll.
 */
export function shouldResync(eventKey: string | null, key: string): boolean {
  return eventKey === null || eventKey === key
}
