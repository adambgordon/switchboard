import { useLayoutEffect, useRef } from 'react'
import { startAnimationSync } from './animationSync'

/**
 * Phase-lock an element's looping CSS animations to a shared origin, so they run in unison across
 * the app regardless of when each element mounted or flipped state.
 *
 * A CSS animation starts its clock when first applied to an element, so independently-mounted dots
 * breathe at the same *rate* but a different *phase*. We re-anchor by pinning each matching
 * animation's `startTime` to 0 (the `document.timeline` origin): animations sharing the timeline
 * with the same startTime and period are phase-identical — no drift, and no per-frame work (the
 * animation stays on the compositor; we only touch it at its start).
 *
 * Pass a `stateKey` that changes whenever the element's animation state changes — e.g. the liveness
 * dot's state class. The layout effect anchors animations already present before the first paint;
 * an `animationstart` subscription anchors animations created or replaced later. `{ subtree: true }`
 * is required to reach the ripple's ::before / ::after ring animations.
 */
export function useSyncedAnimation<T extends HTMLElement>(stateKey: unknown) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Reduced motion pins these animations to ~0 duration, so there's no phase to lock.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    return startAnimationSync({
      subscribe: (onAnimationStart) => {
        el.addEventListener('animationstart', onAnimationStart)
        return () => el.removeEventListener('animationstart', onAnimationStart)
      },
      getAnimations: () =>
        el
          .getAnimations({ subtree: true })
          .filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation)
    })
  }, [stateKey])
  return ref
}
