/**
 * The rail's persisted preferences, as pure parse and fold functions. The hook binding them to
 * localStorage is separate, so this module stays importable under the node tsconfig.
 *
 * All three are APP-WIDE: every window reads and writes the same keys and follows the others' writes.
 * They are deliberately not part of the per-window layout, which a detached window never persists.
 * Each parse takes its fallback as a parameter so a test can prove the default is honored rather than
 * a constant the parser happens to share with it.
 */

export type SidebarMode = 'all' | 'folders'
export type RailDensity = 'compact' | 'spacious'

export const SIDEBAR_MODE_KEY = 'switchboard.sidebarMode'
export const RAIL_DENSITY_KEY = 'switchboard.railDensity'
export const FOLDER_COLLAPSE_KEY = 'switchboard.folderCollapse'

export const DEFAULT_SIDEBAR_MODE: SidebarMode = 'folders'
export const DEFAULT_RAIL_DENSITY: RailDensity = 'compact'

export function parseSidebarMode(raw: string | null, fallback: SidebarMode = DEFAULT_SIDEBAR_MODE): SidebarMode {
  return raw === 'all' || raw === 'folders' ? raw : fallback
}

export function parseRailDensity(raw: string | null, fallback: RailDensity = DEFAULT_RAIL_DENSITY): RailDensity {
  return raw === 'compact' || raw === 'spacious' ? raw : fallback
}

/**
 * Stored per-folder collapse, keyed by project root. Both values are meaningful: `false` records that
 * the user expanded a folder the automatic rule would collapse, so an absent key and `false` differ.
 */
export function parseFolderCollapse(raw: string | null): Record<string, boolean> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, boolean> = {}
  for (const [root, v] of Object.entries(parsed)) {
    if (typeof v === 'boolean') out[root] = v
  }
  return out
}

/**
 * Fold one folder's collapse into the stored map. Applied to a fresh read, not to this window's copy:
 * the map is one value shared by every window, so writing a stale copy back would undo whatever
 * another window changed since this one last read it. Returns `stored` itself when nothing changes.
 */
export function withFolderCollapse(
  stored: Readonly<Record<string, boolean>>,
  root: string,
  collapsed: boolean
): Record<string, boolean> {
  if (Object.hasOwn(stored, root) && stored[root] === collapsed) return stored as Record<string, boolean>
  return { ...stored, [root]: collapsed }
}
