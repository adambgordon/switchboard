/**
 * How much terminal history the app carries, in already-wrapped rows.
 *
 * The two constants below are deliberately equal and MUST be changed together — they are the same
 * product decision seen from two processes, and they used to be independent literals that agreed
 * only by luck. Raising one alone silently wastes the other's work.
 *
 * They are NOT interchangeable, though, because the agents differ:
 *
 * - `CODEX_REPLAY_ROWS` is passed to Codex as `tui.terminal_resize_reflow_max_rows`. Codex renders
 *   to the NORMAL buffer with scrollback and, on every resize, clears its own scrollback and
 *   re-inserts the newest rows from its source-backed transcript, capped at this value. So for
 *   Codex this is what determines the history you can actually scroll back to — including right
 *   after a cross-window handoff, whose repaint nudge is itself a resize. Left unset, Codex
 *   resolves per detected terminal and falls back to 1,000 rows for a host it does not recognise
 *   (ours), so setting it explicitly pins that rather than inheriting a value that could change.
 *
 * - `HANDOFF_SCROLLBACK_ROWS` bounds the xterm snapshot taken when a terminal moves to another
 *   WINDOW. For Codex it only bridges the gap until the reflow above lands. For Claude it is the
 *   whole story: Claude runs on the alternate screen (no scrollback) while its agent is alive, so
 *   this matters only once the agent exits to a plain shell — where there is no reflow to rebuild
 *   anything.
 *
 * Kept modest on purpose: reflow runs on EVERY resize, and this app resizes far more than a plain
 * terminal does (splits, divider drags, the handoff repaint, ⌘R's zoom-wiggle). Snapshot cost was
 * measured at ~11 ms per terminal at 2,000 rows, paid per terminal on a cross-window move.
 *
 * Note this is smaller than the live xterm `scrollback`, which is sized for ordinary shell output
 * and is not rebuilt from anything.
 */
export const CODEX_REPLAY_ROWS = 1000

/** See the note above — must move in lockstep with `CODEX_REPLAY_ROWS`. */
export const HANDOFF_SCROLLBACK_ROWS = 1000
