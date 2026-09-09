import type { PersistedTabLayout, PersistedTabPane } from './types'

export const TAB_WORKSPACE_VERSION = 1

/**
 * Most windows a saved workspace may reopen. Panes are already bounded to 2 a few lines down, but
 * the window list was not: this file is on disk, so a truncated write or a hand edit can present
 * any number of valid-looking single-tab entries, and each one becomes a real BrowserWindow with
 * its own renderer at startup — with no in-app way back. Chosen to match the live-session cap's
 * order of magnitude, which is well past any real layout.
 */
export const MAX_RESTORED_WINDOWS = 8

export interface PersistedTabWorkspace {
  version: typeof TAB_WORKSPACE_VERSION
  windows: PersistedTabLayout[]
}

function paneFrom(value: unknown, claimed: Set<string>): PersistedTabPane | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { sessionIds?: unknown; activeSessionId?: unknown }
  if (!Array.isArray(raw.sessionIds)) return null
  const sessionIds: string[] = []
  for (const value of raw.sessionIds) {
    if (typeof value !== 'string' || !value || claimed.has(value)) continue
    claimed.add(value)
    sessionIds.push(value)
  }
  if (sessionIds.length === 0) return null
  const activeSessionId = raw.activeSessionId === null
    ? null
    : typeof raw.activeSessionId === 'string' && sessionIds.includes(raw.activeSessionId)
      ? raw.activeSessionId
      : sessionIds[0]
  return { sessionIds, activeSessionId }
}

export function sanitizeTabLayout(
  value: unknown,
  claimed: Set<string> = new Set()
): PersistedTabLayout | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { panes?: unknown }
  if (!Array.isArray(raw.panes)) return null
  const panes: PersistedTabPane[] = []
  for (const value of raw.panes.slice(0, 2)) {
    const pane = paneFrom(value, claimed)
    if (pane) panes.push(pane)
  }
  return panes.length > 0 ? { panes } : null
}

export function sanitizeTabWorkspace(value: unknown): PersistedTabWorkspace {
  const empty: PersistedTabWorkspace = { version: TAB_WORKSPACE_VERSION, windows: [] }
  if (!value || typeof value !== 'object') return empty
  const raw = value as { version?: unknown; windows?: unknown }
  if (raw.version !== TAB_WORKSPACE_VERSION || !Array.isArray(raw.windows)) return empty
  // `claimed` is threaded across windows so one conversation cannot come back in two of them —
  // this is the serialization boundary, where a hand-edited or half-written file is the input, and
  // a duplicate restored here would break the one-tab-app-wide rule before the app is even usable.
  const claimed = new Set<string>()
  const windows: PersistedTabLayout[] = []
  for (const value of raw.windows) {
    if (windows.length >= MAX_RESTORED_WINDOWS) break
    const layout = sanitizeTabLayout(value, claimed)
    if (layout) windows.push(layout)
  }
  return { version: TAB_WORKSPACE_VERSION, windows }
}
