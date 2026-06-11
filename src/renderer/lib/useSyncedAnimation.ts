import { useLayoutEffect, useRef } from 'react'

/**
 * Looping animation names that should share a global phase — so every breathing dot (and the
 * welcome mark) breathes in unison, and every "asking" ripple pulses in unison. One-shot
 * entrance animations (sb-fade-up) and the useRailFlip row slides are deliberately excluded.
 */
const SYNCED_ANIMATIONS = new Set(['sb-breathe-dot', 'sb-ripple', 'sb-ripple-core'])

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
 * Pass a `stateKey` that changes whenever the element's animation (re)starts — e.g. the liveness
 * dot's state class — so the anchor re-applies to the freshly-created animation. The effect also
 * runs on mount (layout effects always do), which covers remounts. It runs in a *layout* effect so
 * the first painted frame is already in phase (no visible snap). `{ subtree: true }` is required to
 * reach the ripple's ::before / ::after ring animations (confirmed present in Electron's Chromium).
 */
export function useSyncedAnimation<T extends HTMLElement>(stateKey: unknown) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Reduced motion pins these animations to ~0 duration, so there's no phase to lock.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const anim of el.getAnimations({ subtree: true })) {
      if (anim instanceof CSSAnimation && SYNCED_ANIMATIONS.has(anim.animationName)) {
        anim.startTime = 0
      }
    }
  }, [stateKey])
  return ref
}
