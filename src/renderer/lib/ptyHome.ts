/**
 * Which pane each live terminal is mounted in.
 *
 * A window can hold only ONE xterm per terminal: the renderer's output fan-out keeps a single writer
 * per pty id, and a second one silently kills the first. So showing a terminal in the other pane means
 * unmounting and remounting it — and a remounted xterm attaches to an empty backlog, because no PTY
 * output is retained anywhere to replay, so it comes back blank until something changes its size.
 *
 * The assignment is therefore **sticky**: a terminal is given a pane once, when first seen, and moves
 * only if that pane goes away. That rule is the whole point of this module, and it is pure and tested
 * rather than living in an effect, where a one-line regression to it would look exactly like working
 * code and cost a blank terminal.
 */

/** The bit of a live PTY this needs: its identity, and the conversation it is running. */
export interface HomedPty {
  ptyId: string
  sessionId: string
}

export interface HomeContext {
  paneCount: number
  focusIndex: number
  /** Which pane holds a tab for this conversation (leftmost, if both), or null for none. */
  paneOfSession: (sessionId: string) => number | null
}

/**
 * The next home map. Returns `prev` **by identity** when nothing changes, so a caller storing this in
 * state does not re-render on every pass — this runs on every re-index while anything is live.
 */
export function nextPtyHomes(
  prev: Record<string, number>,
  ptys: HomedPty[],
  ctx: HomeContext
): Record<string, number> {
  let next: Record<string, number> | null = null
  const edit = (): Record<string, number> => (next ??= { ...prev })

  for (const p of ptys) {
    const current = prev[p.ptyId]
    // Already homed to a pane that still exists — leave it exactly where it is. This branch is the
    // stickiness, and it is what stops a terminal being remounted (and blanked) by anything other
    // than its pane disappearing.
    if (current !== undefined && current < ctx.paneCount) continue
    // First sight, or its pane was removed: the pane holding its tab, else the focused one.
    //
    // There is deliberately no `current === home` short-circuit here. Reaching this line means
    // `current` is either absent or >= paneCount, while both branches of `home` resolve to a pane that
    // exists — so the two can never be equal, and a guard for it would be unreachable rather than
    // merely untested. `??`, not `||`: pane 0 is a real answer.
    const tabPane = ctx.paneOfSession(p.sessionId)
    edit()[p.ptyId] = tabPane ?? Math.min(ctx.focusIndex, ctx.paneCount - 1)
  }

  // Forget terminals that have exited, so the map cannot grow for the life of the window.
  const live = new Set(ptys.map((p) => p.ptyId))
  for (const id of Object.keys(prev)) {
    if (!live.has(id)) delete edit()[id]
  }

  return next ?? prev
}

/**
 * Split the live terminals across the panes that will mount them.
 *
 * Two deliberate asymmetries:
 *  - A terminal with **no home yet** goes in NO pane, for that one frame. Mounting it in a guessed
 *    pane and correcting next frame would remount it, which is the one thing this module exists to
 *    avoid; while it is unmounted the pty stream buffers its output rather than losing it.
 *  - A terminal homed to a pane that has just **gone away** falls to pane 0 here rather than waiting
 *    for the home map to catch up, so it moves in one step instead of blinking out for a frame first.
 */
export function partitionPtys<T extends HomedPty>(
  ptys: T[],
  homes: Record<string, number>,
  paneCount: number
): T[][] {
  const out: T[][] = Array.from({ length: Math.max(1, paneCount) }, () => [])
  for (const p of ptys) {
    const home = homes[p.ptyId]
    if (home === undefined) continue
    out[home < out.length ? home : 0].push(p)
  }
  return out
}
