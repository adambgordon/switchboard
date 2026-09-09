import { useCallback, useEffect, useState } from 'react'
import { reorderArray } from './reorder'

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
  /**
   * A live row's sessionId changed under it — keep its slot instead of letting the sync treat it as
   * newly live. MUST be called before the `active-changed` broadcast that carries the new id reaches
   * the sync effect; `PtyManager.bindCodex` emits `bound` before `active-changed` precisely so that
   * ordering holds. See `retargetOrder`.
   */
  retarget: (oldId: string, newId: string) => void
}

/**
 * Swap one id for another IN PLACE, keeping the row's slot. Pure.
 *
 * A live Codex terminal's sessionId can change under it (a placeholder binding to its real rollout,
 * or a drift correction onto a different conversation). Rows are keyed by sessionId, so without this
 * the sync below sees the old id vanish and the new one appear and treats the SAME terminal as newly
 * live — prepending it. That is invisible for a row already at the top, and wrong for any other:
 * `[B, S1, A]` would become `[S2, B, A]` rather than `[B, S2, A]`, discarding a drag position and
 * breaking the rule that an existing Live row holds its slot until the user moves it.
 *
 * Returns the same array reference when there is nothing to do, so callers keep a stable identity.
 *
 * An entry for `newId` that is ALREADY in the list is necessarily stale, not a conflict: `bindCodex`
 * refuses to bind onto a conversation a live PTY owns, so such an entry belongs to a PTY that has
 * already exited and that this list simply has not pruned yet (it lags active state until the passive
 * sync below). So it is dropped and `oldId`'s row is retargeted — which keeps the corrected terminal
 * in its OWN slot. Refusing instead would leave the corrected PTY to inherit the dead row's position
 * once the sync pruned `oldId`, silently relocating a row the user had placed.
 */
export function retargetOrder(order: string[], oldId: string, newId: string): string[] {
  if (oldId === newId) return order
  if (!order.includes(oldId)) return order
  const pruned = order.includes(newId) ? order.filter((id) => id !== newId) : order
  return pruned.map((id) => (id === oldId ? newId : id))
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

  const retarget = useCallback((oldId: string, newId: string) => {
    setOrder((prev) => retargetOrder(prev, oldId, newId))
  }, [])

  return { order, reorder, retarget }
}
