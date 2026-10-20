import type { DragReshape } from './useBlockReorder'

/** Mirror the motion tokens (--dur / --ease in tokens.css), as the folder fold does. */
const COLLAPSE_MS = 180
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Marks the animations this owns, so stopping them cancels nothing else. */
export const COLLAPSE_ID = 'sb-collapse'
/** Clips only a unit's bottom edge while it grows back, so what is not yet uncovered stays hidden
 *  without clipping anything that reaches above or beside it. Constant, so it never interpolates. */
const CLIP_BOTTOM = 'inset(-9999px -9999px 0 -9999px)'
const PROPS = ['height', 'min-height', 'padding-top', 'padding-bottom', 'margin-top', 'margin-bottom', 'overflow', 'opacity'] as const

/**
 * Close a dragged group up around the unit it was grabbed by: every other carried unit folds away to
 * nothing, so the block reflows into the layout of that one unit's drag (see `useBlockReorder`).
 *
 * The same shape as `foldFolder`. Each unit is given its folded state as inline styles — no height, no
 * padding, and a negative margin taking back the block's gap beside it — so the layout is exactly the
 * one it would have without the unit, which is what the drag measures. The fold then plays from where
 * each unit stood.
 *
 * Restoring puts the full layout back at once, so the drop's settle and the rail's glide, which measure
 * positions as the drop renders, read where everything ends up; each unit then grows back in from
 * nothing (`grow`), started once that render's measuring is done (`afterMeasure`). They are not the
 * dragged unit, so they are on screen throughout and grow at once.
 */
export function collapseUnits(units: readonly HTMLElement[]): DragReshape {
  const frames: [Keyframe, Keyframe][] = []
  let back: [Keyframe, Keyframe][] = []
  return {
    apply() {
      frames.length = 0
      // A unit still growing back in from the last drop is measured at its full size.
      for (const u of units) for (const a of u.getAnimations()) if (a.id === COLLAPSE_ID) a.finish()
      for (const u of units) {
        const cs = getComputedStyle(u)
        const gap = u.parentElement ? parseFloat(getComputedStyle(u.parentElement).rowGap) || 0 : 0
        const from: Keyframe = {
          height: `${u.getBoundingClientRect().height}px`,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          marginTop: cs.marginTop,
          marginBottom: cs.marginBottom,
          opacity: cs.opacity
        }
        // The gap a flex column puts after every child but the last; a last child takes back the one
        // before it instead. Two folded neighbors then cancel both of theirs, as if neither were there.
        const last = !u.nextElementSibling
        const to: Keyframe = {
          height: '0px',
          paddingTop: '0px',
          paddingBottom: '0px',
          marginTop: last ? `${-gap}px` : cs.marginTop,
          marginBottom: last ? cs.marginBottom : `${-gap}px`,
          opacity: '0'
        }
        u.style.height = '0px'
        u.style.minHeight = '0px'
        u.style.paddingTop = '0px'
        u.style.paddingBottom = '0px'
        u.style.marginTop = String(to.marginTop)
        u.style.marginBottom = String(to.marginBottom)
        u.style.overflow = 'hidden'
        u.style.opacity = '0'
        frames.push([from, to])
      }
    },
    play() {
      if (reduceMotion()) return
      units.forEach((u, i) => {
        const f = frames[i]
        if (f) u.animate(f, { duration: COLLAPSE_MS, easing: EASE, id: COLLAPSE_ID })
      })
    },
    revert() {
      for (const u of units) {
        for (const a of u.getAnimations()) if (a.id === COLLAPSE_ID) a.cancel()
        for (const p of PROPS) u.style.removeProperty(p)
      }
      back = []
      if (reduceMotion()) return
      // Read in the restored layout — where each unit now sits, and whether it is now its block's last
      // — before anything animates.
      back = units.map((u): [Keyframe, Keyframe] => {
        const cs = getComputedStyle(u)
        const gap = u.parentElement ? parseFloat(getComputedStyle(u.parentElement).rowGap) || 0 : 0
        const last = !u.nextElementSibling
        const natural: Keyframe = {
          height: `${u.getBoundingClientRect().height}px`,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          marginTop: cs.marginTop,
          marginBottom: cs.marginBottom,
          opacity: cs.opacity,
          clipPath: CLIP_BOTTOM
        }
        const folded: Keyframe = {
          height: '0px',
          paddingTop: '0px',
          paddingBottom: '0px',
          marginTop: last ? `${-gap}px` : cs.marginTop,
          marginBottom: last ? cs.marginBottom : `${-gap}px`,
          opacity: '0',
          clipPath: CLIP_BOTTOM
        }
        return [folded, natural]
      })
    },
    grow() {
      const frames = back
      back = []
      if (frames.length === 0) return
      afterMeasure(() =>
        units.forEach((u, i) => u.animate(frames[i], { duration: COLLAPSE_MS, easing: EASE, id: COLLAPSE_ID }))
      )
    }
  }
}

function reduceMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Run `fn` once the render that called this has finished measuring, but before it paints: after every
 * layout effect of the commit — the rail's glide records positions in one that runs after the drag's —
 * and before the frame. A microtask is exactly that window; a frame callback would paint the full
 * layout once before the growth began.
 */
export function afterMeasure(fn: () => void): void {
  queueMicrotask(fn)
}
