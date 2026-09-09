import { useCallback, useEffect, useMemo, useState } from 'react'
import { reorderArray } from './reorder'

/**
 * Pinned conversations — a user-curated, MANUALLY ORDERED list of session IDs that surface in the
 * Tally Rail whether or not they're live. Persisted in localStorage (renderer state; survives
 * restarts). The ordered array is the source of truth (top of the list = index 0); a Set is derived
 * for the rail's membership filters. Newly pinned conversations land at the BOTTOM; the user drags to reorder.
 */
const KEY = 'switchboard.pinnedOrder'
const LEGACY_KEY = 'switchboard.pinnedSessions'

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const arr: unknown = JSON.parse(raw)
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    }
    // One-time migration: the legacy key stored Set-insertion order (oldest pin first) and the rail
    // displayed it reversed (newest on top). The ordered model stores display order directly, so
    // reverse on import to preserve each existing user's visible pin order.
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy) {
      const arr: unknown = JSON.parse(legacy)
      const migrated = Array.isArray(arr)
        ? arr.filter((x): x is string => typeof x === 'string').reverse()
        : []
      save(migrated)
      return migrated
    }
    return []
  } catch {
    return []
  }
}

function save(order: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(order))
  } catch {
    /* storage unavailable — pins just won't persist this run */
  }
}

export interface Pins {
  /** Membership set, derived from `order` — for the rail's `.has()` filters. */
  pinned: Set<string>
  /** Display order, top-first. The source of truth. */
  order: string[]
  toggle: (sessionId: string) => void
  /** Move the pin at index `from` to index `to` (both indices into `order`). */
  reorder: (from: number, to: number) => void
}

export function usePins(): Pins {
  const [order, setOrder] = useState<string[]>(load)

  // Every window shares this list and none of them owns it, so a pin is applied to what is ON DISK
  // rather than to what this window last rendered. Otherwise one window's save serialises its whole
  // stale list and silently unpins everything another window pinned since it loaded — the list is a
  // single value, so there is no per-entry granularity to save it.
  const mutate = useCallback((fn: (stored: string[]) => string[]): void => {
    const stored = load()
    const next = fn(stored)
    if (next === stored) {
      // Adopt the fresh read anyway: our change being a no-op usually means another window already
      // made it.
      setOrder(stored)
      return
    }
    save(next)
    setOrder(next)
  }, [])

  // Another window wrote the list. It folded its change into what is on disk, so disk is newer.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === KEY) setOrder(load())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const toggle = useCallback(
    (sessionId: string) => {
      // New pin lands at the bottom (end of the list); unpin removes.
      mutate((prev) =>
        prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId]
      )
    },
    [mutate]
  )

  const reorder = useCallback(
    (from: number, to: number) => {
      mutate((prev) => reorderArray(prev, from, to))
    },
    [mutate]
  )

  const pinned = useMemo(() => new Set(order), [order])

  return { pinned, order, toggle, reorder }
}
