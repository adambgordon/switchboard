import { useEffect, useState, type ReactNode } from 'react'

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

  // Startup: reveal the app on the frame after the first (white) paint.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setState('fading'))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Refresh: cover instantly on start, fade out on end. The failsafe fades even if `end` never arrives.
  useEffect(() => {
    let failsafe: number | undefined
    const offStart = window.api.onRefreshStart(() => {
      window.clearTimeout(failsafe)
      setState('opaque')
      failsafe = window.setTimeout(() => setState('fading'), 1200)
    })
    const offEnd = window.api.onRefreshEnd(() => {
      window.clearTimeout(failsafe)
      setState('fading')
    })
    return () => {
      window.clearTimeout(failsafe)
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
