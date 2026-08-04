import { useEffect, useMemo, useState } from 'react'
import type { PtyState } from '@shared/types'
import { conversationIdForPty, surfaceKeyForPty } from './ptySurface'

export interface PtyIndex {
  /** All live sessions, in stable spawn order (oldest first). */
  active: PtyState[]
  /** Current projected conversation id -> live PtyState. Unattached hosts are excluded. */
  bySession: Map<string, PtyState>
  /** Current surface key (conversation id or `agent-view:<ptyId>`) -> live PtyState. */
  bySurface: Map<string, PtyState>
  /** Stable transport id -> live PtyState. */
  byPtyId: Map<string, PtyState>
  /** Claude Agent View controller session id -> its stable host PTY. */
  byController: Map<string, PtyState>
}

/** Live-updating set of active PTY-backed sessions. */
export function usePtys(): PtyIndex {
  const [active, setActive] = useState<PtyState[]>([])

  useEffect(() => {
    let alive = true
    let sawPush = false
    const off = window.api.onActiveChanged((a) => {
      if (alive) {
        sawPush = true
        setActive(a)
      }
    })
    window.api.listActive().then((a) => {
      if (alive && !sawPush) setActive(a)
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
    const bySurface = new Map<string, PtyState>()
    const byPtyId = new Map<string, PtyState>()
    const byController = new Map<string, PtyState>()
    for (const p of active) {
      const sessionId = conversationIdForPty(p)
      if (sessionId) bySession.set(sessionId, p)
      bySurface.set(surfaceKeyForPty(p), p)
      byPtyId.set(p.ptyId, p)
      if (p.surface.kind === 'agent-view-host') {
        byController.set(p.surface.controllerSessionId, p)
      }
    }
    return { active: sorted, bySession, bySurface, byPtyId, byController }
  }, [active])
}
