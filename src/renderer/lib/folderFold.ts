import type { DragReshape } from './useBlockReorder'

/** Mirror the motion tokens (--dur / --ease in tokens.css). */
const FOLD_MS = 180
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Marks the animation this owns, so stopping it cancels nothing else. */
const FOLD_ID = 'sb-fold'
/** On the folded folder: clips it to its header and fades its rows (rail.css). The drag's clone is
 *  copied from the folded folder, so it carries the class too. */
const FOLD_CLASS = 'sb-folded'

/**
 * Fold the folder being dragged down to its header, so it moves as one short card while the rest of the
 * rail stays as it was (see `useBlockReorder`'s `reshape`).
 *
 * The folder is given its header's height as a fixed height, rather than hiding its rows: the layout is
 * then exactly the folded one the drag measures, while the rows are still there to fold away. The fold
 * plays from the folder's old height once the drag has measured. Unfolding is instant, with the rows
 * fading back in: the drop's settle and the rail's glide both measure positions the moment the drop
 * renders, and an animated height would hand them a layout that is still moving.
 */
export function foldFolder(folder: HTMLElement): DragReshape {
  let from = 0
  return {
    apply() {
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
      folder.style.height = ''
      folder.classList.remove(FOLD_CLASS)
    }
  }
}
