/**
 * The title-bar bell: which conversations need you, in what order, and what the bell's own dot shows.
 *
 * "Needs you" is the rail's rule (`needsYou` in sidebarModel): asking, or finished and unread. The
 * bell only reorders that set for triage — questions first, since an agent blocked on a reply is
 * waiting on the user in a way a finished turn is not, then the newest — and summarizes it in one dot
 * drawn exactly like a row's.
 */

export type AttentionState = 'asking' | 'awaiting'

export interface AttentionItem {
  sessionId: string
  state: AttentionState
  /** When it last did anything: the question, or the end of the turn. */
  at: number
}

/** The bell's dot: a question anywhere pulses it; otherwise anything unread fills it; else none. */
export function bellState(states: readonly AttentionState[]): AttentionState | null {
  if (states.includes('asking')) return 'asking'
  return states.length > 0 ? 'awaiting' : null
}

/**
 * Questions before unread turns, newest first within each. `items` arrive in rail order, which breaks
 * ties, so two conversations active in the same instant keep the order the rail shows them in.
 */
export function attentionOrder<T extends AttentionItem>(items: readonly T[]): T[] {
  const rank = (s: AttentionState): number => (s === 'asking' ? 0 : 1)
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item.state) - rank(b.item.state) || b.item.at - a.item.at || a.i - b.i)
    .map(({ item }) => item)
}
