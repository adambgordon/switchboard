import { useCallback, useEffect, useState } from 'react'

/**
 * Width bounds + default (px) for the unified left pane. The minimum keeps the rail head's one row in
 * Folders mode, where its tools are widest, on one line with room to spare — the head never wraps, so
 * this bound is what holds it there. Re-measure if the head gains anything.
 */
export const PANE_LIMITS = { min: 300, default: 320, max: 480 } as const

interface LayoutState {
  paneWidth: number
  paneCollapsed: boolean
}

const KEY = 'switchboard.layout'
const DEFAULTS: LayoutState = {
  paneWidth: PANE_LIMITS.default,
  paneCollapsed: false
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    // Tolerate older shapes (sidebarWidth/railWidth/recentMode/sections/…): unknown fields are
    // ignored and missing ones fall back to DEFAULTS, so old layouts degrade cleanly.
    const o = JSON.parse(raw) as Partial<LayoutState>
    return {
      paneWidth: clamp(
        typeof o.paneWidth === 'number' ? o.paneWidth : DEFAULTS.paneWidth,
        PANE_LIMITS.min,
        PANE_LIMITS.max
      ),
      paneCollapsed: o.paneCollapsed === true
    }
  } catch {
    return DEFAULTS
  }
}

export interface Layout extends LayoutState {
  setPaneWidth: (w: number) => void
  togglePane: () => void
  resetPane: () => void
}

export interface LayoutOptions {
  /**
   * Start with the rail collapsed regardless of what is stored — a window opened to show one
   * conversation. Applied to the initial state only, so ⌘B still works normally afterwards.
   */
  collapseRail?: boolean
  /**
   * Whether to write changes back to localStorage. **False for a detached window**, and that is not a
   * nicety: localStorage is shared by every window of the app, so a window that opens with the rail
   * hidden would otherwise persist "collapsed" and hand it to the browser window on next launch.
   */
  persist?: boolean
}

/** Persisted, clamped layout: pane width + collapsed state. */
export function useLayout(opts?: LayoutOptions): Layout {
  const [state, setState] = useState<LayoutState>(() => {
    const loaded = load()
    return opts?.collapseRail ? { ...loaded, paneCollapsed: true } : loaded
  })
  const persist = opts?.persist !== false

  useEffect(() => {
    if (!persist) return
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable */
    }
  }, [state, persist])

  const setPaneWidth = useCallback((w: number) => {
    setState((s) => ({ ...s, paneWidth: clamp(w, PANE_LIMITS.min, PANE_LIMITS.max) }))
  }, [])
  const togglePane = useCallback(() => setState((s) => ({ ...s, paneCollapsed: !s.paneCollapsed })), [])
  const resetPane = useCallback(() => setState((s) => ({ ...s, paneWidth: PANE_LIMITS.default })), [])
  return { ...state, setPaneWidth, togglePane, resetPane }
}
