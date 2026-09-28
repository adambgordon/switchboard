/**
 * Stopping an empty conversation closes its tab.
 *
 * A conversation with no messages has no rail row of its own — the rail shows it only while its
 * terminal lives — so once the user stops it, the tab would be all that is left of it, showing a
 * conversation the app no longer lists. Only an explicit Stop does this: a terminal that exits on its
 * own keeps its tab, since what it printed on the way out (a launch error, say) is worth reading.
 *
 * Decided when the process has actually exited rather than on the click, so a stop that fails leaves
 * the tab alone.
 */

/** The stopped conversations whose terminals have now exited. */
export function endedStops(stopped: ReadonlySet<string>, live: ReadonlyMap<string, unknown>): string[] {
  return [...stopped].filter((id) => !live.has(id))
}

/**
 * Whether a stopped conversation is empty, judged by the index and then by its transcript read from
 * disk. Both must agree: the index trails a new session's first message by up to a second, so a stop
 * right after it would otherwise read as empty and close a conversation that has begun.
 */
export function emptyAfterStop(indexedMessages: number, transcript: { messages: readonly unknown[] } | null): boolean {
  return indexedMessages === 0 && (transcript === null || transcript.messages.length === 0)
}
