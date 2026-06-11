/**
 * Persist and restore the main window's size + position across launches.
 *
 * Kept free of any `electron` import so the geometry stays unit-testable in the
 * node test env (matching `parser.ts` / `indexer.ts`). The caller in `index.ts`
 * supplies the userData dir and the display work areas — that's where
 * `electron` is already imported.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
  fullScreen?: boolean
}

export interface Placement {
  x?: number
  y?: number
  width: number
  height: number
}

const FILE = 'window-state.json'

/**
 * Read persisted bounds from `<dir>/window-state.json`. Returns null on first
 * launch or if the file is missing / corrupt / malformed, so callers fall back
 * to defaults. Width and height are required; x/y are kept only if both parse.
 */
export function loadWindowState(dir: string): WindowState | null {
  let parsed: Partial<WindowState>
  try {
    parsed = JSON.parse(readFileSync(join(dir, FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null
  const state: WindowState = { width: parsed.width, height: parsed.height }
  if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
    state.x = parsed.x
    state.y = parsed.y
  }
  if (parsed.maximized === true) state.maximized = true
  if (parsed.fullScreen === true) state.fullScreen = true
  return state
}

/** Persist window state to `<dir>/window-state.json`. Best-effort — never throws. */
export function saveWindowState(dir: string, state: WindowState): void {
  const out: WindowState = { width: state.width, height: state.height }
  if (typeof state.x === 'number' && typeof state.y === 'number') {
    out.x = state.x
    out.y = state.y
  }
  // Only persist the flags when set, so a plain windowed state stays a clean 4-key file.
  if (state.maximized) out.maximized = true
  if (state.fullScreen) out.fullScreen = true
  try {
    writeFileSync(join(dir, FILE), JSON.stringify(out))
  } catch {
    /* losing window state isn't worth surfacing or crashing over */
  }
}

/**
 * True if `bounds` overlaps at least one display's work area by `minVisible` px
 * on both axes — i.e. enough of the window (including its draggable title bar)
 * is reachable. Guards against restoring onto a monitor that's since been
 * disconnected or rearranged.
 */
export function isOnScreen(bounds: Rect, displays: Rect[], minVisible = 100): boolean {
  return displays.some((d) => {
    const overlapW = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x)
    const overlapH = Math.min(bounds.y + bounds.height, d.y + d.height) - Math.max(bounds.y, d.y)
    return overlapW >= minVisible && overlapH >= minVisible
  })
}

/**
 * Resolve the BrowserWindow size/position from saved state. Falls back to
 * `defaults` for size when nothing is saved, and drops a saved position that's
 * no longer on any display — keeping the size, letting Electron re-center.
 */
export function resolvePlacement(
  saved: WindowState | null,
  displays: Rect[],
  defaults: { width: number; height: number }
): Placement {
  if (!saved) return { ...defaults }
  const placement: Placement = { width: saved.width, height: saved.height }
  if (
    saved.x !== undefined &&
    saved.y !== undefined &&
    isOnScreen({ x: saved.x, y: saved.y, width: saved.width, height: saved.height }, displays)
  ) {
    placement.x = saved.x
    placement.y = saved.y
  }
  return placement
}
