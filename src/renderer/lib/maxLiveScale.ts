/**
 * Scale for the max-live-sessions slider: piecewise-linear, with the DEFAULT pinned to the exact visual
 * midpoint of the track. The recommended value is then the one your eye lands on, and the two halves
 * read as "fewer than default" and "more than default" without needing to read the number at all.
 *
 * The cost is a non-uniform scale — with 2 / 8 / 16 the lower half spends half the track on 6 values and
 * the upper half on 8, so the right side moves faster per pixel. That's the intended trade: this control
 * is glanced at far more often than it is dragged to a specific number.
 *
 * So the `<input type="range">` carries a POSITION rather than the value, and these two functions convert
 * between them. They round-trip for every integer in range (the test walks all of them), which is what
 * stops the thumb drifting when React re-renders the input from the stored value.
 */

/** Track resolution. Positions are integers in [0, SLIDER_STEPS]; the midpoint is exactly half. */
export const SLIDER_STEPS = 100

const HALF = SLIDER_STEPS / 2

/** Where on the track a given cap sits. `mid` lands on exactly half, whatever the bounds are. */
export function positionForValue(value: number, min: number, mid: number, max: number): number {
  if (value <= mid) {
    // A degenerate lower half (default === minimum) has nowhere to place values below it.
    if (mid <= min) return 0
    return Math.round(((value - min) / (mid - min)) * HALF)
  }
  if (max <= mid) return SLIDER_STEPS
  return Math.round(HALF + ((value - mid) / (max - mid)) * HALF)
}

/** The cap a track position denotes. Positions outside the track clamp to the bounds. */
export function valueForPosition(pos: number, min: number, mid: number, max: number): number {
  const p = Math.max(0, Math.min(SLIDER_STEPS, pos))
  if (p <= HALF) return min + Math.round((p / HALF) * (mid - min))
  return mid + Math.round(((p - HALF) / HALF) * (max - mid))
}
