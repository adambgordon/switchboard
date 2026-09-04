import { useCallback, useEffect, useState } from 'react'
import { useStorageSync } from './useStorageSync'

/**
 * The "tabs and split view" preference, persisted in localStorage. Off by default.
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
 * Owned once per window in App, like the other preference hooks. Open windows synchronize through
 * the storage event, so one app preference cannot leave them running different interaction models.
 */
const KEY = 'switchboard.tabs'
const DEFAULT_ENABLED = false

function parse(raw: string | null): boolean {
  if (!raw) return DEFAULT_ENABLED
  try {
    const o = JSON.parse(raw) as { enabled?: unknown }
    return typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_ENABLED
  } catch {
    return DEFAULT_ENABLED
  }
}

function load(): boolean {
  try {
    return parse(localStorage.getItem(KEY))
  } catch {
    return DEFAULT_ENABLED
  }
}

export interface TabsEnabled {
  enabled: boolean
  setEnabled: (value: boolean) => void
}

/** Persisted tabs-and-split preference (default off). */
export function useTabsEnabled(): TabsEnabled {
  const [enabled, setEnabledState] = useState<boolean>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled }))
    } catch {
      /* storage unavailable */
    }
  }, [enabled])

  useStorageSync(KEY, load, setEnabledState)

  const setEnabled = useCallback((v: boolean) => setEnabledState(v), [])

  return { enabled, setEnabled }
}
