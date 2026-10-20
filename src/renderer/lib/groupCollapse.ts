import type { DragReshape } from './useBlockReorder'

/** Mirror the motion tokens (--dur / --ease in tokens.css), as the folder fold does. */
const COLLAPSE_MS = 180
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Marks the animations this owns, so stopping them cancels nothing else. */
const COLLAPSE_ID = 'sb-collapse'
const PROPS = ['height', 'min-height', 'padding-top', 'padding-bottom', 'margin-top', 'margin-bottom', 'overflow', 'opacity'] as const

/**
 * Close a dragged group up around the unit it was grabbed by: every other carried unit folds away to
 * nothing, so the block reflows into the layout of that one unit's drag (see `useBlockReorder`).
 *
 * The same shape as `foldFolder`. Each unit is given its folded state as inline styles — no height, no
 * padding, and a negative margin taking back the block's gap beside it — so the layout is exactly the
 * one it would have without the unit, which is what the drag measures. The fold then plays from where
 * each unit stood. Restoring is instant, for the reason unfolding a folder is: the drop's settle and the
 * rail's glide measure positions the moment the drop renders.
 */
export function collapseUnits(units: readonly HTMLElement[]): DragReshape {
  const frames: [Keyframe, Keyframe][] = []
  return {
    apply() {
      frames.length = 0
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
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
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
    }
  }
}
