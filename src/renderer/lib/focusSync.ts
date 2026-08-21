/**
 * Coordination for the renderer's window-focus flag.
 *
 * The value is owned by the main process, which pushes every transition — but the renderer still has
 * to learn the CURRENT value when it mounts, and that seed is an async round-trip. Two orderings
 * decide whether the flag ends up right, and holding them is the whole reason this module exists:
 *
 *  1. Subscribe BEFORE requesting the seed. A transition that happens while the seed is in flight
 *     must already have a listener, or it is never delivered at all and the flag keeps a value that
 *     is known to be stale.
 *  2. A push always beats the seed. A push observed during the round-trip is newer by construction,
 *     so applying the seed afterward would move the flag BACKWARD to the pre-transition value.
 *
 * Get either wrong and the flag can settle on a value nothing ever corrects — which is exactly the
 * failure this signal was rebuilt to remove, and it is invisible from the outside: everything gated
 * on focus simply stops. So the rules live here, behind injected dependencies that keep the module
 * free of `window` and `electron`, and are covered by test/focusSync.test.ts rather than by reading.
 */
export interface FocusSyncDeps {
  /** Subscribe to pushed transitions. Returns an unsubscribe fn. */
  subscribe: (cb: (focused: boolean) => void) => () => void
  /** Ask for the current value (an async round-trip to whoever owns it). */
  querySeed: () => Promise<boolean>
  /** Apply a resolved value. */
  apply: (focused: boolean) => void
}

/** Start syncing. Returns a teardown fn; nothing is applied after it runs. */
export function startFocusSync(deps: FocusSyncDeps): () => void {
  let live = true
  let pushed = false

  // Rule 1 — subscribe first. Ordering, not preference: the seed below is async.
  const unsubscribe = deps.subscribe((focused) => {
    pushed = true
    if (live) deps.apply(focused)
  })

  void deps
    .querySeed()
    .then((focused) => {
      // Rule 2 — a push already told us something newer; the seed must not undo it.
      if (live && !pushed) deps.apply(focused)
    })
    // The seed can only fail if the owner is gone. Leave the flag alone and let the next pushed
    // transition set it, rather than raise an unhandled rejection.
    .catch(() => {})

  return () => {
    live = false
    unsubscribe()
  }
}
