import type { TurnActivity } from '../../shared/turnActivity'

/**
 * How long a USED terminal with no attributable transcript stays protected after its last use.
 *
 * It exists for one window: a first turn has been submitted, but the conversation it created is
 * not yet attributable to this terminal, so nothing can say the agent is working. Stopping it
 * there destroys live work. The protection is time-bounded rather than absolute because a
 * permanent one would be a way to exceed the cap without limit — the mistake this policy is
 * written to avoid. Generous against a window that normally closes in seconds.
 */
export const UNATTRIBUTED_GRACE_MS = 3 * 60_000

/** One live PTY, reduced to the facts the eviction decision rests on. */
export interface EvictionCandidate {
  ptyId: string
  /**
   * ms epoch of the last time a person used this terminal, seeded to its spawn time so one that
   * has never been used is not automatically the oldest.
   */
  lastInputAt: number
  /**
   * Has a person ever typed, pasted or dropped into this terminal? Tracked as its own flag rather
   * than derived from `lastInputAt > startedAt`, which reads false when first use lands in the same
   * millisecond as the spawn. Affects only ORDER, never whether a terminal can be reclaimed.
   */
  used: boolean
  /**
   * What the session is doing, RESOLVED — `shared/turnActivity.ts#resolveTurnActivity`, the same
   * derivation the liveness dot uses. Deliberately not the raw `turnState`: that reads
   * `in_progress` for a turn abandoned by a previous process (so a resumed interrupted session
   * would be protected forever) and `awaiting` for a terminal holding an unanswered runtime
   * question (so the prompt would be discarded). Both corrections live in that one module.
   */
  activity: TurnActivity
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
 * The protected cases are protected because stopping them destroys something that exists nowhere
 * else: `working` is a turn mid-flight, `asking` is a question whose prompt lives only in that
 * terminal, and an on-screen terminal is one being looked at — a pane going blank reads as a
 * glitch even when nothing is lost. None can be sustained indefinitely across many terminals the
 * way an idle one can, which is what makes them safe to treat as absolute.
 *
 * The tiers rank by WHAT IS LOST, not by age:
 *
 * 0. Unattributable and never used — an empty terminal. Nothing to come back to.
 * 1. Idle. The transcript is on disk, so stopping it costs only the running process.
 * 2. Unattributable but used — possibly an unsent message, or a shell the agent exited to. Last
 *    resort, because this is the only tier whose content exists nowhere but in that terminal.
 *    Held out of reach entirely for {@link UNATTRIBUTED_GRACE_MS} after its last use.
 */
function tierOf(candidate: EvictionCandidate, now: number): number | null {
  if (candidate.onScreen) return null
  if (candidate.activity === 'working' || candidate.activity === 'asking') return null
  if (candidate.activity === 'unknown') {
    if (!candidate.used) return 0
    return now - candidate.lastInputAt < UNATTRIBUTED_GRACE_MS ? null : 2
  }
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
 * **No input is terminal output.** Output cannot separate a working agent from a resting one: an
 * agent TUI may repaint on a fixed timer whether or not anything is happening, which makes a
 * terminal untouched for hours indistinguishable from one mid-task. That is why `activity` comes
 * from the transcript and why recency counts real use rather than bytes written — a repaint tick
 * would keep resetting it forever, and so would the terminal answering the program's own queries.
 *
 * `now` is passed rather than read so the grace window is testable without a clock.
 */
export function chooseEvictionTargets(
  candidates: readonly EvictionCandidate[],
  maxLive: number,
  now: number
): string[] {
  // The caller is about to add one, so the set has to end up at maxLive INCLUDING the newcomer.
  const needed = candidates.length + 1 - maxLive
  if (needed <= 0) return []
  return candidates
    .map((candidate) => ({ candidate, tier: tierOf(candidate, now) }))
    .filter((ranked): ranked is { candidate: EvictionCandidate; tier: number } => ranked.tier !== null)
    .sort((a, b) => a.tier - b.tier || a.candidate.lastInputAt - b.candidate.lastInputAt)
    .slice(0, needed)
    .map((ranked) => ranked.candidate.ptyId)
}
