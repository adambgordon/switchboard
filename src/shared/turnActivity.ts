import type { TurnState } from './types'

/**
 * What a session is actually DOING — the one derivation, shared by the liveness dot and the
 * live-session cap.
 *
 * It lives in `shared/` because both processes need it and neither owns it. Deriving it twice is
 * how the two disagree, and they disagree in opposite directions: the dot would call a session
 * idle while the cap called it busy, or the cap would stop a terminal the dot was showing as
 * blocked on the user. Raw `ConversationMeta.turnState` is NOT that answer — two corrections sit
 * between them, and any consumer reading the raw field re-opens both.
 */

/**
 * The transcript facts this resolution needs, as recorded for one conversation. Both fields are
 * optional so that a `ConversationMeta` satisfies this structurally and the renderer can pass its
 * metadata straight in — the alternative is an adapter at every call site, which is one more place
 * for the two consumers to drift apart.
 */
export interface TurnSnapshot {
  turnState?: TurnState
  lastActivityAt?: number | null
}

/**
 * Is this `in_progress` turn a CARRYOVER from a dead process rather than live work?
 *
 * A session can be live (its shell pty is alive) while showing a turn that belongs to a PRIOR
 * agent run: quit mid-turn — which writes no interrupt sentinel — then resume later. The resumed
 * agent replays history and sits idle; it never finishes that dangling turn.
 *
 * The tell: anything the CURRENT process does is timestamped after it started. So activity
 * predating the live process's spawn was written by an earlier, now-dead one. A genuinely working
 * turn — including a multi-minute tool still running — has activity after spawn, so it is never
 * flagged, and no special-casing of tool_use vs tool_result is needed.
 */
export function isStaleTurnCarryover(
  snapshot: TurnSnapshot | undefined,
  liveStartedAt: number | null
): boolean {
  return (
    snapshot?.turnState === 'in_progress' &&
    liveStartedAt != null &&
    snapshot.lastActivityAt != null &&
    liveStartedAt > snapshot.lastActivityAt
  )
}

/**
 * Timestamp of the current user-input request, if any. A structured transcript question stays
 * authoritative; otherwise a runtime notification counts only until newer transcript activity
 * supersedes it. Deliberately ignores generic terminal output and keystrokes.
 *
 * The runtime path is load-bearing rather than a nicety: an agent may raise an approval or
 * plan-mode question that it never writes to the transcript, and open it only AFTER completing the
 * turn — so the transcript reads `awaiting` while the terminal is in fact holding an unanswered
 * prompt. Reading `turnState` alone therefore misses exactly the case a user would most mind
 * losing.
 */
export function inputRequestedAt(
  snapshot: TurnSnapshot | undefined,
  runtimeInputRequestedAt: number | null
): number | null {
  if (snapshot?.turnState === 'awaiting_input') {
    return Math.max(snapshot.lastActivityAt ?? 0, runtimeInputRequestedAt ?? 0)
  }
  const parsedActivityAt = snapshot?.lastActivityAt ?? 0
  return runtimeInputRequestedAt != null && runtimeInputRequestedAt > parsedActivityAt
    ? runtimeInputRequestedAt
    : null
}

/**
 * `unknown` means no transcript is attributable to this terminal at all — a session whose identity
 * has not been proven, or one whose work went elsewhere. It is NOT the same as idle: the terminal
 * may be mid-first-turn with its conversation not yet observable, which is why callers must treat
 * the two differently rather than folding unknown into idle.
 */
export type TurnActivity = 'working' | 'asking' | 'idle' | 'unknown'

export function resolveTurnActivity(
  snapshot: TurnSnapshot | undefined,
  liveStartedAt: number | null,
  runtimeInputRequestedAt: number | null
): TurnActivity {
  // Checked FIRST, and before the unknown gate: a runtime question can arrive on a terminal whose
  // conversation is not yet attributable, and it outranks a completed turn by construction.
  if (inputRequestedAt(snapshot, runtimeInputRequestedAt) != null) return 'asking'
  if (snapshot?.turnState === undefined) return 'unknown'
  if (snapshot.turnState === 'in_progress') {
    return isStaleTurnCarryover(snapshot, liveStartedAt) ? 'idle' : 'working'
  }
  return 'idle'
}
