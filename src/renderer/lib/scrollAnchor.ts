/**
 * A reading position that survives reflow: the point of an element that sits at a scroller's top edge. Inside the
 * element it is a fraction of the element's height, so a tall paragraph or code block that rewraps keeps the same
 * passage at the edge; outside it (an element starting below the edge) it is a pixel offset, which rewrapping does
 * not change.
 */
export interface AnchorPoint {
  fraction: number
  offset: number
}

/** All positions in one coordinate space, such as viewport pixels from getBoundingClientRect. */
export function anchorPoint(elTop: number, elHeight: number, viewTop: number): AnchorPoint {
  const fraction = elHeight > 0 ? Math.min(1, Math.max(0, (viewTop - elTop) / elHeight)) : 0
  return { fraction, offset: viewTop - (elTop + fraction * elHeight) }
}

/** The scrollTop that returns the anchored point to the top edge once the element has moved or resized. */
export function anchoredScrollTop(
  scrollTop: number, elTop: number, elHeight: number, viewTop: number, point: AnchorPoint
): number {
  return scrollTop + elTop + point.fraction * elHeight + point.offset - viewTop
}
