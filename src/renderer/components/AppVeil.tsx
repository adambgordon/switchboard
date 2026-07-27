import { useEffect, useRef, useState, type ReactNode } from 'react'

const REFRESH_MIN_OPAQUE_MS = 300

/**
 * A white cover that fades out on launch (a soft fade-in from white) and brackets the ⌘R refresh: the
 * main process fires `refreshStart` before the zoom wiggle (we cover instantly) and `refreshEnd` after
 * it's restored (we fade back out), so the relayout never flashes. It sits above everything.
 *
 * State: `opaque` (covering, no transition) → `fading` (opacity→0 transition) → `hidden` (unmounted).
 * Startup begins `opaque` so the first painted frame is white, then fades after one frame. A failsafe
 * fade guards against a missed `refreshEnd` (e.g. the window churns) leaving the veil stuck.
 */
type VeilState = 'opaque' | 'fading' | 'hidden'

export default function AppVeil(): ReactNode {
  const [state, setState] = useState<VeilState>('opaque')
  const refreshStartedAtRef = useRef(0)

  // Startup: reveal the app on the frame after the first (white) paint.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setState('fading'))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Refresh: cover instantly on start, fade out on end. The failsafe fades even if `end` never arrives.
  useEffect(() => {
    let failsafe: number | undefined
    let reveal: number | undefined
    const offStart = window.api.onRefreshStart(() => {
      window.clearTimeout(failsafe)
      window.clearTimeout(reveal)
      refreshStartedAtRef.current = performance.now()
      setState('opaque')
      failsafe = window.setTimeout(() => setState('fading'), 1200)
    })
    const offEnd = window.api.onRefreshEnd(() => {
      window.clearTimeout(failsafe)
      const elapsed = performance.now() - refreshStartedAtRef.current
      reveal = window.setTimeout(
        () => setState('fading'),
        Math.max(0, REFRESH_MIN_OPAQUE_MS - elapsed)
      )
    })
    return () => {
      window.clearTimeout(failsafe)
      window.clearTimeout(reveal)
      offStart()
      offEnd()
    }
  }, [])

  if (state === 'hidden') return null
  return (
    <div
      className={`sb-app-veil${state === 'fading' ? ' fading' : ''}`}
      onTransitionEnd={() => setState((s) => (s === 'fading' ? 'hidden' : s))}
    />
  )
}
