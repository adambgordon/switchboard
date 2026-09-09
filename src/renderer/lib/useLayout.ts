import { useCallback, useEffect, useState } from 'react'

/** Width bounds + default (px) for the unified left pane. */
export const PANE_LIMITS = { min: 240, default: 320, max: 480 } as const

/** The three collapsible sections of the pane. */
export type SectionKey = 'pinned' | 'live' | 'recent'

interface LayoutState {
  paneWidth: number
  paneCollapsed: boolean
  /** Per-section COLLAPSED flags (true = collapsed). */
  sections: Record<SectionKey, boolean>
}

const KEY = 'switchboard.layout'
const DEFAULTS: LayoutState = {
  paneWidth: PANE_LIMITS.default,
  paneCollapsed: false,
  sections: { pinned: false, live: false, recent: false }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    // Tolerate older shapes (sidebarWidth/railWidth/recentMode/…): unknown fields are
    // ignored and missing ones fall back to DEFAULTS, so old layouts degrade cleanly.
    const o = JSON.parse(raw) as Partial<LayoutState>
    const s = (o.sections ?? {}) as Partial<Record<SectionKey, boolean>>
    return {
      paneWidth: clamp(
        typeof o.paneWidth === 'number' ? o.paneWidth : DEFAULTS.paneWidth,
        PANE_LIMITS.min,
        PANE_LIMITS.max
      ),
      paneCollapsed: o.paneCollapsed === true,
      sections: {
        pinned: s.pinned === true,
        live: s.live === true,
        recent: s.recent === true
      }
    }
  } catch {
    return DEFAULTS
  }
}

export interface Layout extends LayoutState {
  setPaneWidth: (w: number) => void
  togglePane: () => void
  resetPane: () => void
  toggleSection: (key: SectionKey) => void
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

/** Persisted, clamped layout: pane width + collapsed state, and per-section collapse. */
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
  const toggleSection = useCallback((key: SectionKey) => {
    setState((s) => ({ ...s, sections: { ...s.sections, [key]: !s.sections[key] } }))
  }, [])

  return { ...state, setPaneWidth, togglePane, resetPane, toggleSection }
}
