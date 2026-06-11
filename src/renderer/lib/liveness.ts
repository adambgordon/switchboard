// Pure liveness resolution — no React, no DOM — so it can be unit-tested directly (the
// renderer otherwise isn't). Imports the shared contract by RELATIVE path (not the `@shared`
// alias) so vitest, which has no alias config, resolves it; the import is type-only anyway.
import type { ConversationMeta, LiveState } from '../../shared/types'

/**
 * Is this `in_progress` turn a CARRYOVER from a dead process rather than live work?
 *
 * The PtyManager wraps a login shell and types `claude` into it, so a session can be "live"
 * (shell pty alive) yet show a turn that belongs to a PRIOR claude run: you quit/kill Switchboard
 * mid-turn (which writes no `[Request interrupted]` sentinel — unlike Esc), then later **resume**
 * the session. Resume spawns a brand-new process; the resumed claude just replays history and
 * sits idle at its prompt — it never finishes that dangling turn — so the dot would breathe
 * forever.
 *
 * The tell: anything the CURRENT process actually does is timestamped AFTER it started. So if the
 * last real activity (`lastActivityAt`) predates the live process's spawn (`liveStartedAt`), the
 * turn was written by an earlier, now-dead process → it isn't live work. A genuinely working turn
 * — including a multi-minute tool still running — has activity AFTER spawn, so it's never flagged
 * (no special-casing of tool_use vs tool_result needed). `liveStartedAt` is the live
 * `PtyState.startedAt`; null when the row isn't live (no demotion — and no dot anyway).
 */
function isStaleCarryover(meta: ConversationMeta | undefined, liveStartedAt: number | null): boolean {
  return (
    meta?.turnState === 'in_progress' &&
    liveStartedAt != null &&
    meta.lastActivityAt != null &&
    liveStartedAt > meta.lastActivityAt
  )
}

/**
 * Is a manual "mark unread" override currently in force? It applies only until a *new* turn
 * lands (a later turn supersedes it, handing back to the seen-timestamp logic). `markedAt` is
 * `unread[id]` from useSeen (undefined when unset).
 */
export function isManualUnread(markedAt: number | undefined, meta: ConversationMeta | undefined): boolean {
  if (markedAt == null) return false
  const endedAt = meta?.turnEndedAt ?? meta?.lastActivityAt ?? 0
  return endedAt <= markedAt
}

/**
 * Resolve a live session's liveness from the transcript's turn-state plus the local "seen"
 * marker — NOT from PTY output activity. A live `claude` TUI repaints constantly (every
 * keystroke echoes as output), so `pty.status === 'busy'` is ~always true and is not a turn
 * signal — it never drives the dot. A session with no turn-state yet (freshly spawned, sitting
 * at an empty prompt before its first real message) is therefore `quiet`, not `working`: there
 * is nothing happening until a real turn is written. `lookingNow` (selected + window focused)
 * counts as seen immediately, so a turn finishing — or a question arriving — under the user's
 * eyes reads as quiet rather than flashing awaiting / asking.
 *
 * `liveStartedAt` is the live process's spawn time (`PtyState.startedAt`). An `in_progress` turn
 * whose last activity predates it is a {@link isStaleCarryover carryover} from a dead process
 * (quit/killed mid-turn, then resumed) — treated as a finished turn so the resumed, idle session
 * stops breathing. The demoted turn flows through the normal `awaiting` seen/looking logic.
 */
export function resolveLiveState(
  meta: ConversationMeta | undefined,
  lastSeenAt: number,
  lookingNow: boolean,
  manualUnread: boolean,
  liveStartedAt: number | null
): LiveState {
  // Carryover from a dead process → treat as a finished (aborted) turn.
  const turn = isStaleCarryover(meta, liveStartedAt) ? 'awaiting' : meta?.turnState
  if (turn === 'awaiting_input') {
    // Claude is blocked on your reply (AskUserQuestion / ExitPlanMode). A manual "mark unread"
    // forces the pulse back — the asking counterpart to the `awaiting` override below — even while
    // looked-at / seen, so marking a question state unread (⇧⌘U / Option+click / the menu) returns
    // it to pulsing. Otherwise the same clear-when-looking rule as `awaiting`: looking counts as
    // seen, so the dot drops to quiet even if you haven't actually answered yet.
    if (manualUnread) return 'asking'
    if (lookingNow) return 'quiet'
    const askedAt = meta?.lastActivityAt ?? 0
    return askedAt > lastSeenAt ? 'asking' : 'quiet'
  }
  if (turn === 'in_progress') return 'working'
  // A manual "mark unread" forces the solid dot for a finished conversation, overriding both
  // `lookingNow` and the seen timestamp (the active states above keep their own animation).
  if (manualUnread) return 'awaiting'
  if (turn === 'awaiting') {
    if (lookingNow) return 'quiet'
    // For a demoted carryover, turnEndedAt is null, so this falls back to lastActivityAt (the
    // pre-resume activity) — the right "unread since" anchor.
    const endedAt = meta?.turnEndedAt ?? meta?.lastActivityAt ?? 0
    return endedAt > lastSeenAt ? 'awaiting' : 'quiet'
  }
  // No transcript turn-state yet (freshly spawned, nothing written): the session is live but
  // idle at its prompt. Quiet, NOT working — PTY output (incl. keystroke echo) is not a turn.
  return 'quiet'
}
