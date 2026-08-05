import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Marks the animations this hook owns, so a re-measure can cancel only its own in-flight slides. */
const FLIP_ID = 'sb-flip'
/** Set on a row for the duration of its slide; CSS hides the hover-revealed pin toggle while present. */
const FLIPPING_CLASS = 'sb-flipping'
// Mirror the motion tokens (--dur / --ease in tokens.css): 220ms, expo-out "confident settle".
const DUR = 220
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'

/**
 * FLIP (First-Last-Invert-Play) position animation for the conversation rows.
 *
 * Rows move between sections — a conversation gets pinned, resumed, or unpinned — by unmounting from
 * one section's subtree and mounting in another (each section is its own keyed Fragment). Without
 * help that reads as a *teleport*: the row vanishes from its old spot and appears in the new one.
 * This hook makes the move glide: after each order-changing commit it measures every visible row's
 * viewport position, compares to the previous commit, and for any row that moved it plays a
 * compositor-only `translateY` from the old offset back to zero. A brand-new row (e.g. a freshly
 * spawned session arriving in Live) fades and rises in instead.
 *
 * Web Animations API rather than inline-style transitions: it's compositor-driven, auto-cleans up
 * (nothing lingers on the element for React to fight), and an in-flight slide is cancelled before we
 * re-measure (so rapid pin/unpin reads true settled positions, never a mid-animation transform).
 *
 * Cost is one `querySelectorAll` + `getBoundingClientRect` pass over the visible rows (≤ a few dozen),
 * and ONLY when the order actually changes — never per render, never per frame. No play happens on the
 * initial mount, nor when only `controlSig` changed (a search filter or a section collapse/expand):
 * those still refresh the baseline so the next real move measures correctly, but stay visually instant,
 * so typing in search and toggling a section never trigger a slide cascade.
 *
 * @param containerRef the scroll container holding the rows (`.sb-rail-body`)
 * @param orderSig     changes whenever the visible rows' identity or order changes (drives a slide)
 * @param controlSig   changes on collapse / search / show-more — a layout change we deliberately don't animate
 */
export function useRailFlip(
  containerRef: RefObject<HTMLElement>,
  orderSig: string,
  controlSig: string
): void {
  const prevTops = useRef<Map<string, number>>(new Map())
  const prevControlSig = useRef(controlSig)
  const firstRun = useRef(true)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const rows = container.querySelectorAll<HTMLElement>('.sb-row[data-session]')

    // Cancel our own in-flight slides so getBoundingClientRect reads settled positions, not
    // mid-animation transformed ones — keeps rapid pin/unpin from compounding offsets.
    for (const el of rows) {
      for (const anim of el.getAnimations()) if (anim.id === FLIP_ID) anim.cancel()
      el.classList.remove(FLIPPING_CLASS) // clean slate (cancel() fires oncancel, not onfinish)
    }

    // "Last": where every visible row sits now. Viewport coords, so a cross-section move is one
    // continuous slide (all rows share the same scroll container).
    const tops = new Map<string, number>()
    for (const el of rows) {
      const id = el.dataset.session
      if (id) tops.set(id, el.getBoundingClientRect().top)
    }

    const controlChanged = controlSig !== prevControlSig.current
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const animate = !firstRun.current && !controlChanged && !reduce

    if (animate) {
      for (const el of rows) {
        const id = el.dataset.session
        if (!id) continue
        const prev = prevTops.current.get(id)
        let anim: Animation | undefined
        if (prev != null) {
          // "Invert" + "Play": start the moved row shifted to its old position, settle it to zero.
          const dy = prev - tops.get(id)!
          if (Math.abs(dy) > 0.5) {
            anim = el.animate(
              [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
              { duration: DUR, easing: EASE, id: FLIP_ID }
            )
          }
        } else {
          // No prior position — a genuinely new row (or one revealed from a hidden region): fade + rise.
          anim = el.animate(
            [
              { opacity: 0, transform: 'translateY(6px)' },
              { opacity: 1, transform: 'translateY(0)' }
            ],
            { duration: DUR, easing: EASE, id: FLIP_ID }
          )
        }
        // The pin toggle is hover-revealed, but a compositor transform doesn't re-run :hover — so a
        // row that begins its slide under the cursor would keep the pin visible for the whole glide.
        // Tag it while it animates; CSS hides the pin until the slide settles.
        if (anim) {
          el.classList.add(FLIPPING_CLASS)
          anim.onfinish = () => el.classList.remove(FLIPPING_CLASS)
        }
      }
    }

    prevTops.current = tops
    prevControlSig.current = controlSig
    firstRun.current = false
  }, [containerRef, orderSig, controlSig])
}
