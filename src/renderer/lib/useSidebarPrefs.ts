import { useCallback, useState } from 'react'
import {
  FOLDER_COLLAPSE_KEY,
  RAIL_DENSITY_KEY,
  SIDEBAR_MODE_KEY,
  parseFolderCollapse,
  parseRailDensity,
  parseSidebarMode,
  withFolderCollapse,
  withFoldersCollapse,
  type RailDensity,
  type SidebarMode
} from './sidebarPrefs'
import { useStorageSync } from './useStorageSync'

/**
 * The rail's app-wide preferences, bound to localStorage and followed across windows. Written only
 * by the setters — never from an effect, which would stamp a value into every profile that merely
 * opened the app and erase the difference between "never chose" and "chose this" (see `useDotColor`).
 */
export interface SidebarPrefs {
  mode: SidebarMode
  setMode: (mode: SidebarMode) => void
  density: RailDensity
  setDensity: (density: RailDensity) => void
  /** Stored per-folder collapse, keyed by project root. */
  collapsed: Readonly<Record<string, boolean>>
  setFolderCollapsed: (root: string, collapsed: boolean) => void
  /** Collapse all / Expand all. */
  setFoldersCollapsed: (roots: Iterable<string>, collapsed: boolean) => void
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — the choice lasts this run only */
  }
}

const readMode = (): SidebarMode => parseSidebarMode(readKey(SIDEBAR_MODE_KEY))
const readDensity = (): RailDensity => parseRailDensity(readKey(RAIL_DENSITY_KEY))
const readCollapse = (): Record<string, boolean> => parseFolderCollapse(readKey(FOLDER_COLLAPSE_KEY))

export function useSidebarPrefs(): SidebarPrefs {
  const [mode, setModeState] = useState<SidebarMode>(readMode)
  const [density, setDensityState] = useState<RailDensity>(readDensity)
  const [collapsed, setCollapsedState] = useState<Readonly<Record<string, boolean>>>(readCollapse)
  useStorageSync(SIDEBAR_MODE_KEY, readMode, setModeState)
  useStorageSync(RAIL_DENSITY_KEY, readDensity, setDensityState)
  useStorageSync<Readonly<Record<string, boolean>>>(FOLDER_COLLAPSE_KEY, readCollapse, setCollapsedState)

  const setMode = useCallback((next: SidebarMode) => {
    setModeState(next)
    writeKey(SIDEBAR_MODE_KEY, next)
  }, [])
  const setDensity = useCallback((next: RailDensity) => {
    setDensityState(next)
    writeKey(RAIL_DENSITY_KEY, next)
  }, [])
  // Folded into a fresh read: the map is one value every window shares.
  const mutateCollapse = useCallback((fn: (stored: Record<string, boolean>) => Record<string, boolean>) => {
    const stored = readCollapse()
    const next = fn(stored)
    if (next !== stored) writeKey(FOLDER_COLLAPSE_KEY, JSON.stringify(next))
    setCollapsedState(next)
  }, [])
  const setFolderCollapsed = useCallback(
    (root: string, value: boolean) => mutateCollapse((stored) => withFolderCollapse(stored, root, value)),
    [mutateCollapse]
  )
  const setFoldersCollapsed = useCallback(
    (roots: Iterable<string>, value: boolean) => mutateCollapse((stored) => withFoldersCollapse(stored, roots, value)),
    [mutateCollapse]
  )

  return { mode, setMode, density, setDensity, collapsed, setFolderCollapsed, setFoldersCollapsed }
}
