import type { DragReshape } from './useBlockReorder'
import { afterMeasure } from './groupCollapse'

/** Mirror the motion tokens (--dur / --ease in tokens.css). */
const FOLD_MS = 180
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Marks the animations this owns, so stopping them cancels nothing else. */
export const FOLD_ID = 'sb-fold'
/** Clips the folder's bottom edge while it unfolds — the rows it is uncovering — and nothing else, so a
 *  header rising above the folder's box stays whole. Constant, so it never interpolates. */
const CLIP_BOTTOM = 'inset(-9999px -9999px 0 -9999px)'
/** On the folded folder: clips it to its header and fades its rows (rail.css). The drag's clone is
 *  copied from the folded folder, so it carries the class too. */
const FOLD_CLASS = 'sb-folded'

/**
 * Fold the folder being dragged down to its header, so it moves as one short card while the rest of the
 * rail stays as it was (see `useBlockReorder`'s `reshape`).
 *
 * The folder is given its header's height as a fixed height, rather than hiding its rows: the layout is
 * then exactly the folded one the drag measures, while the rows are still there to fold away. The fold
 * plays from the folder's old height once the drag has measured.
 *
 * Unfolding is the fold run back, with the same split: the full height is restored at once, because the
 * drop's settle and the rail's glide measure positions as the drop renders and must read where
 * everything ends up; the folder then grows back from its header (`grow`). It is the dragged unit, and
 * stays hidden under its settling clone until that lands; the clone is only its folded header, so the
 * rows below it are let show for that while, and are uncovered as the folder grows rather than after.
 */
export function foldFolder(folder: HTMLElement): DragReshape {
  let from = 0
  let unfold: [Keyframe, Keyframe] | null = null
  return {
    apply() {
      // A drag hides the whole folder, so nothing may still hold its rows visible — as the last drop's
      // fold does if this drag began before that drop's clone landed.
      for (const c of Array.from(folder.children)) {
        if (c instanceof HTMLElement && !c.classList.contains('sb-group-head')) c.style.removeProperty('visibility')
      }
      // A folder still unfolding from the last drop is measured at its full height.
      for (const a of folder.getAnimations()) if (a.id === FOLD_ID) a.finish()
      from = folder.getBoundingClientRect().height
      const head = folder.querySelector<HTMLElement>(':scope > .sb-group-head')
      if (!head) return
      // The header's margins count: the first folder's header rises into the space above it.
      const cs = getComputedStyle(head)
      folder.style.height = `${head.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)}px`
      folder.classList.add(FOLD_CLASS)
    },
    play() {
      if (!folder.style.height || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      folder.animate([{ height: `${from}px` }, { height: folder.style.height }], { duration: FOLD_MS, easing: EASE, id: FOLD_ID })
    },
    revert() {
      for (const a of folder.getAnimations()) if (a.id === FOLD_ID) a.cancel()
      const folded = folder.style.height
      folder.style.height = ''
      folder.classList.remove(FOLD_CLASS)
      unfold = null
      if (!folded || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const full = `${folder.getBoundingClientRect().height}px`
      unfold = [
        { height: folded, clipPath: CLIP_BOTTOM },
        { height: full, clipPath: CLIP_BOTTOM }
      ]
    },
    grow(revealIn, clone) {
      const frames = unfold
      unfold = null
      if (!frames) return
      // The clone stops being folded with it — its folder glyph opens as its rows come back, rather than
      // when it lands. Its own rows stay under its clip; it is the real folder's that show.
      clone?.classList.remove(FOLD_CLASS)
      if (revealIn > 0) {
        // Its header is the clone's; everything under the header is not, and may show already. Left
        // set, with no timer to take it back: once the folder shows it changes nothing, and a timer of
        // its own would run out a frame before the clone lands, blinking the rows out until it did. The
        // next drag of the folder clears it before hiding the folder (`apply`).
        for (const c of Array.from(folder.children)) {
          if (c instanceof HTMLElement && !c.classList.contains('sb-group-head')) c.style.visibility = 'visible'
        }
      }
      afterMeasure(() => folder.animate(frames, { duration: FOLD_MS, easing: EASE, id: FOLD_ID }))
    }
  }
}
