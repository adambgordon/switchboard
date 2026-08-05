import { useEffect, useMemo, useState } from 'react'
import type { PtyState } from '@shared/types'

export interface PtyIndex {
  /** All live sessions, in stable spawn order (oldest first). */
  active: PtyState[]
  /** sessionId -> live PtyState (only non-exited). */
  bySession: Map<string, PtyState>
}

/** Live-updating set of active PTY-backed sessions. */
export function usePtys(): PtyIndex {
  const [active, setActive] = useState<PtyState[]>([])

  useEffect(() => {
    let alive = true
    window.api.listActive().then((a) => {
      if (alive) setActive(a)
    })
    const off = window.api.onActiveChanged((a) => {
      if (alive) setActive(a)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return useMemo(() => {
    // Order by spawn time (immutable), NOT lastActivity — sorting on a live
    // timestamp made rows jump to the top whenever a session emitted output or
    // its terminal was opened. startedAt is stable, so positions hold and a
    // newly-spawned session simply appends at the bottom.
    const sorted = [...active].sort((a, b) => a.startedAt - b.startedAt)
    const bySession = new Map<string, PtyState>()
    for (const p of active) bySession.set(p.sessionId, p)
    return { active: sorted, bySession }
  }, [active])
}
