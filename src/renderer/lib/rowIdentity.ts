import type { ConversationMeta, PtyState } from '../../shared/types'

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
