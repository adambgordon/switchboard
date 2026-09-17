import type { TurnActivity } from '../../shared/turnActivity'

/**
 * How long an unanswered input request keeps a terminal out of reach.
 *
 * `asking` is the one protection with no natural end. A question the agent ANSWERS is superseded by
 * later transcript activity, and one the user answers clears on their keystroke — but a question
 * merely abandoned leaves both untouched, and the prompt sits on screen claiming the terminal
 * forever. Every other veto here is self-limiting; this is the only one that needs a clock, because
 * any rule that protects a live terminal indefinitely is a way to exceed the cap without limit.
 *
 * Long enough to walk away from a plan approval and come back to it. Note what lapsing does and does
 * not mean: the terminal stops being untouchable and starts being RANKED, so an empty terminal or a
 * finished conversation is still taken before it, and nothing is stopped at all until the user opens
 * another conversation. The dot deliberately keeps pulsing past this — the prompt really is still
 * there, and dimming the row would be a lie (see liveness).
 */
export const STALE_REQUEST_MS = 30 * 60_000

/**
 * How long ANY used terminal is protected after its last use, whatever its transcript says.
 *
 * `activity` comes from the conversation index, which lags reality: submitting a turn does not
 * update the snapshot, so for a moment a session that has just been given work still reads as
 * finished. Recency of use is the one fact that is current at the instant of the decision, and this
 * window covers the gap — comfortably longer than the poll interval that closes it.
 *
 * Generalised deliberately. Special-casing "a turn was just submitted" would need a submission
 * signal the manager does not have, whereas "someone touched this seconds ago, so do not act on a
 * stale reading of it" is both sufficient and a sane LRU rule in its own right.
 */
export const RECENT_USE_GRACE_MS = 30_000

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
  /**
   * When the outstanding input request was raised, or null when there is none. Carried ALONGSIDE
   * `activity` rather than folded into it because `asking` is the one state that needs bounding, and
   * the resolution that produces it cannot express "still waiting, but no longer sacred".
   */
  askedAt: number | null
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
 * else: `working` is a turn mid-flight — which now includes work only the agent itself reports, so a
 * subagent running inside the session's process counts even while its transcript sits unwritten —
 * `asking` is a question whose prompt lives only in that terminal, and an on-screen terminal is one
 * being looked at, where a pane going blank reads as a glitch even when nothing is lost.
 *
 * Two of those three end by themselves: work finishes, and a pane stops being looked at. `asking`
 * does not, so it is the one veto with a clock on it.
 *
 * The tiers rank by WHAT IS LOST, not by age:
 *
 * 0. Unattributable and never used — an empty terminal. Nothing to come back to.
 * 1. Idle. The transcript is on disk, so stopping it costs only the running process.
 * 2. Unattributable but used — possibly an unsent message, or a shell the agent exited to. Last
 *    resort, because this is the only tier whose content exists nowhere but in that terminal.
 */
function tierOf(candidate: EvictionCandidate, now: number): number | null {
  if (candidate.onScreen) return null
  if (candidate.activity === 'working') return null
  // Bounded, unlike the rest: see STALE_REQUEST_MS. A lapsed request does not become a different
  // activity — it just stops vetoing, and falls through to be ranked like the finished turn the
  // transcript shows.
  if (candidate.activity === 'asking') {
    if (candidate.askedAt == null) return 1
    if (now - candidate.askedAt < STALE_REQUEST_MS) return null
  }
  // Applies to every tier, because `activity` may simply not have caught up with what the user did
  // a moment ago. Gated on `used` — an untouched terminal holds nothing whenever it was opened, so
  // extending this to one would briefly make a burst of new conversations unreclaimable.
  if (candidate.used && now - candidate.lastInputAt < RECENT_USE_GRACE_MS) return null
  // No grace beyond that 30 seconds, and do not add one here. A longer window would be reaching for
  // the gap between submitting a first turn and its conversation becoming attributable, which the
  // recency guard above already covers for every tier — while what it would actually catch is a
  // terminal merely TYPED INTO and never submitted, a state that never resolves on its own, so a
  // half-written line would hold a slot for as long as the user kept touching it. What protects a
  // possible draft is its RANK, not a timer: tier 2 goes after every empty terminal and every
  // finished conversation, and is reached only when it is the last candidate left.
  if (candidate.activity === 'unknown') return candidate.used ? 2 : 0
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
