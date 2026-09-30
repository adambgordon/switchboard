import type { PtyState } from '@shared/types'

/**
 * An empty conversation's tab and its terminal end together, whichever the user ends first.
 *
 * A conversation with no messages has no rail row of its own — the rail shows it only while its
 * terminal lives. So stopping it closes its tab, or the tab would be all that is left of it, showing a
 * conversation the app no longer lists; and closing its tab stops it, or it would linger in the rail
 * as a running conversation nothing is showing. Only the user's own Stop or close does either: a
 * terminal that exits on its own keeps its tab, since what it printed on the way out (a launch error,
 * say) is worth reading, and a tab that merely moves — to the other pane, another window — is still
 * open.
 *
 * Each is decided once the other side has settled — the process has exited, the transcript has been
 * re-read — rather than on the click, so a stop that fails leaves the tab alone.
 */

/** The stopped conversations whose terminals have now exited. */
export function endedStops(stopped: ReadonlySet<string>, live: ReadonlyMap<string, unknown>): string[] {
  return [...stopped].filter((id) => !live.has(id))
}

/**
 * Whether a conversation is empty, judged by the index and then by its transcript read from disk. Both
 * must agree: the index trails a new session's first message by up to a second, so a stop or close
 * right after it would otherwise read as empty and end a conversation that has begun.
 */
export function confirmedEmpty(indexedMessages: number, transcript: { messages: readonly unknown[] } | null): boolean {
  return indexedMessages === 0 && (transcript === null || transcript.messages.length === 0)
}

/**
 * Whether closing this conversation's tab should stop its terminal, before the transcript is re-read
 * to confirm it. A running terminal with nothing indexed — which includes an unlinked Codex terminal,
 * whose rollout does not exist until its first prompt — except one whose work went into a Claude
 * background agent: that writes no transcript of its own, so it looks empty while the agent works.
 * And except a terminal someone has used: it may hold a draft not yet sent, and an unlinked Codex
 * terminal's prompt may already have started a rollout under an id not yet bound to it, which no read
 * under its placeholder can see. Closing the tab of either leaves it running, for its own Stop.
 */
export function stopsOnClose(pty: Pick<PtyState, 'parkedJob' | 'usedByUser'> | undefined, indexedMessages: number): boolean {
  return pty !== undefined && pty.parkedJob === null && indexedMessages === 0 && !pty.usedByUser
}
