import type { TurnState } from '../../shared/types'

/** One live PTY, reduced to the facts the eviction decision rests on. */
export interface EvictionCandidate {
  ptyId: string
  /**
   * ms epoch of the last keystroke sent to this terminal, seeded to its spawn time so a terminal
   * that has never been typed into is not automatically the oldest.
   */
  lastInputAt: number
  /**
   * Has a person ever typed, pasted or dropped into this terminal? Tracked as its own flag rather
   * than derived from `lastInputAt > startedAt`, which reads false when first use lands in the same
   * millisecond as the spawn. Affects only ORDER, never whether a terminal can be reclaimed.
   */
  used: boolean
  /** The turn-state of the conversation this terminal is known to own; undefined when none is. */
  turnState: TurnState | undefined
  /** Showing in some window's pane right now, in any window. */
  onScreen: boolean
}

/**
 * How readily this terminal may be stopped — lower goes first — or `null` for the few that may not
 * be stopped at all.
 *
 * **Only genuinely-in-flight work blocks reclamation.** Everything else is a matter of ORDER, not
 * permission, because any rule that protects a terminal forever is a way to exceed the cap without
 * limit: whatever the rule is, a user can keep making terminals that satisfy it.
 *
 * The three protected cases are protected because stopping them destroys something that exists
 * nowhere else: `in_progress` is a turn mid-flight, `awaiting_input` is a question whose prompt
 * lives only in that terminal, and an on-screen terminal is one being looked at — a pane going
 * blank reads as a glitch even when nothing is lost. None of these can be sustained indefinitely
 * across many terminals the way an idle one can.
 *
 * The tiers rank by WHAT IS LOST, not by age:
 *
 * 0. No conversation and never used — an empty terminal. Nothing to come back to.
 * 1. A finished turn. The transcript is on disk, so stopping it costs only the running process.
 * 2. No conversation but used — possibly an unsent message, or a shell the agent exited to. Last
 *    resort, because this is the only tier whose content exists nowhere but in that terminal.
 */
function tierOf(candidate: EvictionCandidate): number | null {
  if (candidate.onScreen) return null
  if (candidate.turnState === 'in_progress' || candidate.turnState === 'awaiting_input') return null
  if (candidate.turnState === undefined) return candidate.used ? 2 : 0
  return 1
}

/**
 * Which live PTYs to stop so that one more can start without exceeding the cap — in the order they
 * should be taken, and empty when nothing qualifies.
 *
 * **Returns as many as it takes, not one.** The live set can legitimately sit ABOVE the cap: the
 * user can lower it in Preferences (which deliberately closes nothing by itself), and the set is
 * allowed to grow whenever nothing is eligible rather than interrupt work. Freeing a single slot
 * per spawn never converges from either state.
 *
 * **Ordered by what is lost, then by age** (see tierOf): an empty terminal goes before a finished
 * conversation however much older that conversation is, and a terminal that may hold unsent text
 * goes last of all. Within a tier the least recently used goes first.
 *
 * **Both inputs are transcript- or use-derived, never terminal output.** Output cannot separate a
 * working agent from a resting one: an agent TUI may repaint on a fixed timer whether or not
 * anything is happening, which makes a terminal untouched for hours indistinguishable from one
 * mid-task. That is also why recency counts real use rather than bytes written — a repaint tick
 * would keep resetting it forever, and so would the terminal answering the program's own queries.
 */
export function chooseEvictionTargets(
  candidates: readonly EvictionCandidate[],
  maxLive: number
): string[] {
  // The caller is about to add one, so the set has to end up at maxLive INCLUDING the newcomer.
  const needed = candidates.length + 1 - maxLive
  if (needed <= 0) return []
  return candidates
    .map((candidate) => ({ candidate, tier: tierOf(candidate) }))
    .filter((ranked): ranked is { candidate: EvictionCandidate; tier: number } => ranked.tier !== null)
    .sort((a, b) => a.tier - b.tier || a.candidate.lastInputAt - b.candidate.lastInputAt)
    .slice(0, needed)
    .map((ranked) => ranked.candidate.ptyId)
}
