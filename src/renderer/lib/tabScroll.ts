export const TAB_SCROLL_EDGE = 28
const SCROLL_EDGE_TOLERANCE = 1

export interface TabRuleRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface TabRuleGeometry {
  width: number
  height: number
  rowBottoms: number[]
}

/** Size the shared rule layer from tabs alone, so its previous size can never hold overflow open. */
export function tabRuleGeometry(
  strip: TabRuleRect,
  tabs: readonly TabRuleRect[],
  scrollLeft: number,
  scrollTop: number
): TabRuleGeometry {
  const rowBottoms = [...new Set(tabs.map((tab) => tab.bottom - strip.top + scrollTop))]
  return {
    // clientWidth/clientHeight round to whole CSS pixels, leaving a visible sliver at page zoom.
    width: Math.max(strip.right - strip.left, ...tabs.map((tab) => tab.right - strip.left + scrollLeft)),
    height: Math.max(strip.bottom - strip.top, ...rowBottoms),
    rowBottoms
  }
}

export function tabScrollEdges(scroll: number, viewport: number, content: number) {
  const max = Math.max(0, content - viewport)
  return {
    before: max > SCROLL_EDGE_TOLERANCE && scroll > SCROLL_EDGE_TOLERANCE,
    after: scroll < max - SCROLL_EDGE_TOLERANCE
  }
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

export interface TabEdgeMotion<Target = unknown> {
  target: Target
  direction: -1 | 1
  remainder: number
}
export interface TabScrollRequest<Target> {
  target: Target
  direction: -1 | 1
  delta: number
}

export function tabDragScrollRequest<Target>(
  previous: TabEdgeMotion<Target> | null, target: Target, speed: number, elapsed: number, scroll: number, maxScroll: number
): TabScrollRequest<Target> | null {
  if (!speed || (speed < 0 ? scroll <= SCROLL_EDGE_TOLERANCE : scroll >= maxScroll - SCROLL_EDGE_TOLERANCE)) return null
  const direction = speed < 0 ? -1 : 1
  const remainder = previous && previous.target === target && previous.direction === direction ? previous.remainder : 0
  return { target, direction, delta: remainder + speed * Math.max(0, Math.min(elapsed, 32)) / 1000 }
}

/** Rounding can defer less than one physical pixel; larger lost movement means the browser clamped. */
export function tabDragScrollFeedback<Target>(
  request: TabScrollRequest<Target>, before: number, after: number, pixel: number
): TabEdgeMotion<Target> | null {
  const remainder = request.delta - (after - before)
  if (Math.abs(remainder) >= pixel) return null
  return { target: request.target, direction: request.direction, remainder }
}
