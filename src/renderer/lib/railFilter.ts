/**
 * Which conversations the rail shows: the ones the user has hidden, and the filter a window has chosen.
 * Pure, so the one decision the rail, keyboard navigation and the menus all read is reachable from the
 * unit tests; the hook binding the hidden sets to localStorage is `useRailHidden`.
 *
 * Hidden here is the user's choice, stored app-wide. It is unrelated to delegated Codex threads, which
 * main withholds from every surface before the rail sees them (`SidebarInput.delegated`).
 */

export type RailCriterion = 'hidden' | 'live'

/** The criteria a window has chosen. Per window and never stored, so a launch never opens narrowed. */
export type RailFilter = ReadonlySet<RailCriterion>

export const NO_FILTER: RailFilter = new Set()

/** The criteria, in the order the filter menu lists them. */
export const RAIL_CRITERIA: readonly { id: RailCriterion; label: string }[] = [
  { id: 'hidden', label: 'Hidden' },
  { id: 'live', label: 'Live' }
]

/** What a row is, for each criterion. */
export type RowFacts = Readonly<Record<RailCriterion, boolean>>

/**
 * Whether the filter admits a row. Hidden is the one thing the unfiltered rail leaves out, so choosing
 * it swaps which side shows rather than narrowing: no filter shows what is not hidden, Hidden shows only
 * what is. Every other criterion narrows, and chosen criteria combine, so Hidden and Live is what is
 * both hidden and running.
 */
export function admits(filter: RailFilter, facts: RowFacts): boolean {
  if (facts.hidden !== filter.has('hidden')) return false
  for (const c of filter) if (!facts[c]) return false
  return true
}

export interface UserHidden {
  /** Conversations hidden one by one. */
  rows: ReadonlySet<string>
  /** Folders hidden whole, by project root: every conversation in one, in both modes. */
  folders: ReadonlySet<string>
}

export const NOTHING_HIDDEN: UserHidden = { rows: new Set(), folders: new Set() }

/**
 * Why a conversation is hidden, or null when it is not. Its folder answers first: unhiding the
 * conversation alone would not bring it back while the folder stays hidden.
 */
export function hiddenBy(hidden: UserHidden, id: string, root: string): 'folder' | 'self' | null {
  if (hidden.folders.has(root)) return 'folder'
  return hidden.rows.has(id) ? 'self' : null
}

export const HIDDEN_ROWS_KEY = 'switchboard.hiddenConversations'
export const HIDDEN_FOLDERS_KEY = 'switchboard.hiddenFolders'

/** A stored hidden set: a JSON array of ids or roots. Anything else reads as empty. */
export function parseHiddenSet(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set()
  }
  if (!Array.isArray(parsed)) return new Set()
  return new Set(parsed.filter((v): v is string => typeof v === 'string'))
}

/**
 * Fold one hide or unhide into the stored set. Applied to a fresh read, not to this window's copy, for
 * the reason `withFolderCollapse` is: the set is shared by every window. Returns `stored` itself when
 * nothing changes.
 */
export function withHidden(stored: ReadonlySet<string>, key: string, hidden: boolean): ReadonlySet<string> {
  if (stored.has(key) === hidden) return stored
  const next = new Set(stored)
  if (hidden) next.add(key)
  else next.delete(key)
  return next
}
