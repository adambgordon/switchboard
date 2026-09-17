export const TAB_SCROLL_EDGE = 28

export function tabScrollEdges(scroll: number, viewport: number, content: number) {
  const max = Math.max(0, content - viewport)
  return { before: max > 1 && scroll > 1, after: scroll < max - 1 }
}

interface ScrollWheel {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  metaKey: boolean
}

/** Use one axis only: diagonal trackpad gestures must not count their movement twice. */
export function tabWheelDelta(event: ScrollWheel, viewport: number): number {
  if (event.ctrlKey || event.metaKey) return 0
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? viewport : 1
  return delta * unit
}

/** Pixels per second while a drag rests inside either edge of the visible strip. */
export function tabEdgeScrollSpeed(x: number, left: number, right: number): number {
  const edge = Math.min(TAB_SCROLL_EDGE, (right - left) / 2)
  if (x < left + edge) return -480 * (left + edge - x) / edge
  if (x > right - edge) return 480 * (x - right + edge) / edge
  return 0
}
