import { useCallback, useMemo, useState } from 'react'

/**
 * Pinned conversations — a user-curated, MANUALLY ORDERED list of session IDs that surface in the
 * Tally Rail whether or not they're live. Persisted in localStorage (renderer state; survives
 * restarts). The ordered array is the source of truth (top of the list = index 0); a Set is derived
 * for the rail's membership filters. Newly pinned conversations land on top; the user drags to reorder.
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

/** Pure move-one-item reorder (extracted for unit tests). Returns the SAME array on a no-op. */
export function reorderArray<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
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

  const toggle = useCallback((sessionId: string) => {
    setOrder((prev) => {
      // New pin lands on top (index 0); unpin removes.
      const next = prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [sessionId, ...prev]
      save(next)
      return next
    })
  }, [])

  const reorder = useCallback((from: number, to: number) => {
    setOrder((prev) => {
      const next = reorderArray(prev, from, to)
      if (next !== prev) save(next)
      return next
    })
  }, [])

  const pinned = useMemo(() => new Set(order), [order])

  return { pinned, order, toggle, reorder }
}
