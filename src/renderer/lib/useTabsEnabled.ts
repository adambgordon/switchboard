import { useCallback, useEffect, useState } from 'react'

/**
 * The "tabs and split view" preference, persisted in localStorage. On by default.
 *
 * One switch governs the whole family — the tab strip, the vertical split, and opening a
 * conversation in its own window — because they are one model, not three features.
 *
 * **Off is a degenerate case of that model, not a second code path.** With it off the window holds
 * one pane containing exactly one preview tab, so every open replaces it: which is what the app did
 * before tabs existed. The flag therefore gates only three things — whether the strip renders,
 * whether the promotion gestures do anything (so a tab never accumulates), and whether the split /
 * new-window commands and their shortcuts exist. Nothing in the reducer, the bind policy, or the
 * liveness and read-state paths asks about it. A flag that forked the state model would double the
 * number of places every invariant has to hold.
 *
 * Owned once in App, like the other preference hooks — a second `useState(load)` copy would desync
 * from this one's writes.
 */
const KEY = 'switchboard.tabs'

function load(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return true
    const o = JSON.parse(raw) as { enabled?: unknown }
    return typeof o.enabled === 'boolean' ? o.enabled : true
  } catch {
    return true
  }
}

export interface TabsEnabled {
  enabled: boolean
  setEnabled: (value: boolean) => void
}

/** Persisted tabs-and-split preference (default on). */
export function useTabsEnabled(): TabsEnabled {
  const [enabled, setEnabledState] = useState<boolean>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled }))
    } catch {
      /* storage unavailable */
    }
  }, [enabled])

  const setEnabled = useCallback((v: boolean) => setEnabledState(v), [])

  return { enabled, setEnabled }
}
