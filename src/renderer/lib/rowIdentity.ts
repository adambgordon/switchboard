import type { ConversationMeta, LiveState, PtyState } from '../../shared/types'
import { isManualUnread, resolveLiveState } from './liveness'

/**
 * A live terminal whose work went into a Claude background agent rather than its own transcript. Such
 * a session has the agent's marker but never writes a conversation of its own, so it would otherwise
 * render as an empty "New conversation · 0 msg" row while the user is busy in it.
 *
 * `messageCount === 0` is what identifies an unindexed session: the indexer drops zero-message
 * conversations, so any meta that came from it has at least one, and only the renderer's synthesized
 * stand-in has none. It follows that this becomes false the moment the session writes anything of its
 * own — the row corrects itself with no state to reset.
 */
export function isParkedOnlyRow(pty: PtyState | null, meta: ConversationMeta): boolean {
  return !!pty?.parkedJob && meta.messageCount === 0
}

/**
 * A live terminal with no transcript Switchboard can attribute to it — either an unbound Codex
 * session (`provisional`) or one whose work is in a background agent. Neither may be given one of the
 * four liveness states, offered read/unread, or counted as anything but `unlinked`: those all assert
 * something about a conversation that is not known to be this terminal's.
 */
export function isUnlinkedRow(pty: PtyState | null, meta: ConversationMeta): boolean {
  return !!pty && (pty.provisional || isParkedOnlyRow(pty, meta))
}

/**
 * What to call this row. A parked-only terminal names the background agent its work went into, having
 * no conversation of its own to name; everything else uses its own title.
 *
 * Shared by the rail and the main pane deliberately: deriving it twice is how the sidebar ends up
 * naming the agent while the header still says "New conversation" — one thing described two ways,
 * which is the whole failure this row exists to correct.
 */
export function displayTitleForRow(pty: PtyState | null, meta: ConversationMeta): string {
  return isParkedOnlyRow(pty, meta) && pty?.parkedJob?.name ? pty.parkedJob.name : meta.title
}

/**
 * What dot this row gets, if any — the single derivation of liveness for a conversation row.
 *
 * `null` means "no dot": either the row isn't live, or it's live but {@link isUnlinkedRow unlinked},
 * in which case any state resolved here would describe a conversation not known to be this
 * terminal's. Callers that bucket rows can therefore read `null` as unlinked whenever they already
 * know the pty is live, rather than re-testing the predicate.
 *
 * This composition — gate, then resolve — was previously hand-copied at three call sites in `App`,
 * and one of them had been written without the gate, which is how a background-agent row came to
 * show a liveness dot for someone else's transcript. It lives in `lib/` so it is reachable from the
 * unit tests (`App` is not, being React), and in THIS module rather than `liveness` because the gate
 * is the identity concern: the dependency runs one way, so liveness stays ignorant of identity.
 */
export function resolveRowLiveState(
  pty: PtyState | null,
  meta: ConversationMeta,
  lastSeenAt: number,
  lookingNow: boolean,
  /** The raw `unread[id]` mark from useSeen; whether it still applies is decided here. */
  manualUnreadAt: number | undefined
): LiveState | null {
  if (!pty) return null
  if (isUnlinkedRow(pty, meta)) return null
  return resolveLiveState(
    meta,
    lastSeenAt,
    lookingNow,
    isManualUnread(manualUnreadAt, meta),
    pty.startedAt,
    pty.inputRequestedAt
  )
}
