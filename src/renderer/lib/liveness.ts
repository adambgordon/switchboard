// Pure liveness resolution — no React, no DOM — so it can be unit-tested directly (the
// renderer otherwise isn't). Imports the shared contract by RELATIVE path (not the `@shared`
// alias) so vitest, which has no alias config, resolves it; the import is type-only anyway.
import type { ConversationMeta, LiveState } from '../../shared/types'
import { inputRequestedAt, isStaleTurnCarryover } from '../../shared/turnActivity'

/**
 * Both rules below are the SHARED ones in `shared/turnActivity.ts` — the live-session cap reads
 * the same two, because a session cannot be idle for one consumer and busy for another. These are
 * thin `ConversationMeta` adapters over them, nothing more; put any change to the rules there.
 */
function isStaleCarryover(meta: ConversationMeta | undefined, liveStartedAt: number | null): boolean {
  return isStaleTurnCarryover(meta, liveStartedAt)
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

/** See the note above `isStaleCarryover`: the rule itself lives in `shared/turnActivity.ts`. */
export function currentInputRequestedAt(
  meta: ConversationMeta | undefined,
  runtimeInputRequestedAt: number | null
): number | null {
  return inputRequestedAt(meta, runtimeInputRequestedAt)
}

/**
 * Resolve a live session's liveness from the transcript's turn-state plus the local "seen"
 * marker — NOT from PTY output activity. A live agent TUI repaints constantly (every
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
  liveStartedAt: number | null,
  runtimeInputRequestedAt: number | null = null
): LiveState {
  // Carryover from a dead process → treat as a finished (aborted) turn.
  const turn = isStaleCarryover(meta, liveStartedAt) ? 'awaiting' : meta?.turnState
  const askedAt = currentInputRequestedAt(meta, runtimeInputRequestedAt)
  if (askedAt != null) {
    // The agent is blocked on your reply. A manual "mark unread"
    // forces the pulse back — the asking counterpart to the `awaiting` override below — even while
    // looked-at / seen, so marking a question state unread (⇧⌘U / Option+click / the menu) returns
    // it to pulsing. Otherwise the same clear-when-looking rule as `awaiting`: looking counts as
    // seen, so the dot drops to quiet even if you haven't actually answered yet.
    if (manualUnread) return 'asking'
    if (lookingNow) return 'quiet'
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
