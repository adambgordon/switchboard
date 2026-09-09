/**
 * Which pane each live terminal is mounted in.
 *
 * A window holds one stable xterm per terminal in the window-level TerminalDeck. Moving its tab
 * changes the portal host while keeping that component, parser state and scrollback mounted.
 *
 * A terminal follows the pane holding its tab, so moving a live tab cannot strand its xterm behind a
 * disabled "other pane" control. With no local tab it remains sticky: focus changes and transient
 * indexing gaps are not reasons to rebuild a terminal.
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
    const tabPane = ctx.paneOfSession(p.sessionId)
    if (tabPane !== null) {
      if (current === tabPane) continue
      edit()[p.ptyId] = tabPane
      continue
    }
    // With no local tab, preserve a valid home. This is what keeps another window's terminal and a
    // locally-closed live tab from remounting whenever pane focus changes.
    if (current !== undefined && current < ctx.paneCount) continue
    // First sight, or its pane was removed: fall back to the focused pane.
    //
    // There is deliberately no equality short-circuit here. Reaching this line means `current` is
    // absent or outside the layout, while the fallback is guaranteed to be a pane that exists.
    edit()[p.ptyId] = Math.min(ctx.focusIndex, ctx.paneCount - 1)
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
 *    pane and correcting next frame would move it twice, which is the one thing this module exists
 *    to avoid; main retains output until an owner can mount it.
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
