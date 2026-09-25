/**
 * Drag autoscroll, shared by the tab strip (horizontal) and the rail (vertical): how fast a drag
 * resting in a scroller's edge band scrolls it, and the per-frame bookkeeping that carries sub-pixel
 * movement between frames without building a backlog when the browser clamps.
 */

/** The edge band's depth, in CSS pixels. The tab strip's fades are drawn to the same depth. */
export const SCROLL_EDGE = 28
/** Pixels per second at the outer edge of the band — the fastest a drag scrolls. */
export const SCROLL_MAX_SPEED = 480
/** Fractional scroll endpoints at page zoom can sit up to a pixel short of their rounded limit. */
export const SCROLL_EDGE_TOLERANCE = 1

/** Pixels per second while a drag rests inside either edge of a scroller, on whichever axis the
 *  caller passes: `pos` is the pointer, `start` / `end` the scroller's visible edges. */
export function edgeScrollSpeed(pos: number, start: number, end: number): number {
  const edge = Math.min(SCROLL_EDGE, (end - start) / 2)
  if (pos < start + edge) return -SCROLL_MAX_SPEED * (start + edge - pos) / edge
  if (pos > end - edge) return SCROLL_MAX_SPEED * (pos - end + edge) / edge
  return 0
}

export interface EdgeMotion<Target = unknown> {
  target: Target
  direction: -1 | 1
  remainder: number
}
export interface ScrollRequest<Target> {
  target: Target
  direction: -1 | 1
  delta: number
}

export function dragScrollRequest<Target>(
  previous: EdgeMotion<Target> | null, target: Target, speed: number, elapsed: number, scroll: number, maxScroll: number
): ScrollRequest<Target> | null {
  if (!speed || (speed < 0 ? scroll <= SCROLL_EDGE_TOLERANCE : scroll >= maxScroll - SCROLL_EDGE_TOLERANCE)) return null
  const direction = speed < 0 ? -1 : 1
  const remainder = previous && previous.target === target && previous.direction === direction ? previous.remainder : 0
  return { target, direction, delta: remainder + speed * Math.max(0, Math.min(elapsed, 32)) / 1000 }
}

/** Rounding can defer less than one physical pixel; larger lost movement means the browser clamped. */
export function dragScrollFeedback<Target>(
  request: ScrollRequest<Target>, before: number, after: number, pixel: number
): EdgeMotion<Target> | null {
  const remainder = request.delta - (after - before)
  if (Math.abs(remainder) >= pixel) return null
  return { target: request.target, direction: request.direction, remainder }
}
