import { useCallback, useEffect, useState } from 'react'
import { reorderArray } from './usePins'

/**
 * The Live section's row order — a MANUALLY ordered list of currently-live, unpinned session IDs.
 * Unlike pins this is EPHEMERAL (in-memory React state, not localStorage): live PTYs don't survive
 * an app restart, so there's nothing to persist. The array's membership equals the displayed Live
 * rows (live ∧ unpinned), so a row's index in `order` matches its index on screen — which is what
 * `useRowReorder` needs to resolve drag from/to indices (exactly like the Pinned section).
 *
 * Every newly-live session — whether started fresh (⌘N / +) or resumed — lands on **top**; existing
 * rows hold their slots and only move when you drag them. So the Live list never re-sorts on its own.
 */
export interface LiveOrder {
  /** Display order, top-first — the source of truth for the Live section. */
  order: string[]
  /** Move the row at index `from` to index `to` (both indices into `order`). */
  reorder: (from: number, to: number) => void
}

export function useLiveOrder(liveUnpinnedIds: string[]): LiveOrder {
  const [order, setOrder] = useState<string[]>([])
  // Membership/identity signature — the effect re-syncs only when the live-unpinned set changes,
  // not on every render (liveUnpinnedIds is a fresh array each render).
  const sig = liveUnpinnedIds.join('|')

  useEffect(() => {
    setOrder((prev) => {
      const liveSet = new Set(liveUnpinnedIds)
      const kept = prev.filter((id) => liveSet.has(id)) // drop dead/pinned, preserve manual order
      const known = new Set(kept)
      const fresh = liveUnpinnedIds.filter((id) => !known.has(id)) // newly live
      if (fresh.length === 0 && kept.length === prev.length) return prev // no change → stable identity
      let next = kept
      for (const id of fresh) next = [id, ...next] // newly-live sessions land on top
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- liveUnpinnedIds folded into `sig`
  }, [sig])

  const reorder = useCallback((from: number, to: number) => {
    setOrder((prev) => reorderArray(prev, from, to))
  }, [])

  return { order, reorder }
}
