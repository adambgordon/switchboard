import { SCROLL_MAX_SPEED, edgeScrollSpeed } from './edgeScroll'
import { reorderArray } from './reorder'

/**
 * The geometry of a block drag in the rail, pure so it can be tested (see `useBlockReorder`).
 *
 * Every position here is in the scroll container's CONTENT coordinates — a viewport y minus the
 * container's top, plus its scrollTop. Measured that way, positions captured when the drag starts stay
 * true however far the rail scrolls under the pointer, by wheel or by autoscroll; viewport positions
 * would go stale the moment it moved.
 */

/** A draggable unit's untransformed box. */
export interface Slot {
  top: number
  height: number
}

export function contentY(viewportY: number, containerTop: number, scrollTop: number): number {
  return viewportY - containerTop + scrollTop
}

/**
 * How far a sibling moves to open or close the gap: the dragged unit's height plus the gap between
 * units, measured beside it rather than assumed, so a CSS change to the gap cannot desync the glide.
 */
export function dragStride(slots: readonly Slot[], from: number): number {
  const self = slots[from]
  const next = slots[from + 1]
  const prev = slots[from - 1]
  const gap = next ? next.top - (self.top + self.height) : prev ? self.top - (prev.top + prev.height) : 0
  return self.height + gap
}

/** The dragged unit's center, held within its block so every slot stays reachable at the extremes. */
export function clampCenter(center: number, slots: readonly Slot[]): number {
  const first = slots[0]
  const last = slots[slots.length - 1]
  return Math.max(first.top, Math.min(last.top + last.height, center))
}

/**
 * Where the clone is drawn: following the pointer, but no further than `overshoot` past its block's
 * ends, and never out of the rail's visible area (`view`, the content range on screen), so it neither
 * floats off with the pointer nor hangs out of the rail while it autoscrolls. A unit too tall to fit
 * the view — a long folder — is bounded by its block alone. Targeting clamps separately (`clampCenter`).
 */
export function cloneTop(
  top: number,
  slots: readonly Slot[],
  height: number,
  overshoot: number,
  view: { top: number; bottom: number }
): number {
  const first = slots[0]
  const last = slots[slots.length - 1]
  let lo = first.top - overshoot
  let hi = last.top + last.height - height + overshoot
  const viewLo = Math.max(lo, view.top)
  const viewHi = Math.min(hi, view.bottom - height)
  if (viewLo <= viewHi) {
    lo = viewLo
    hi = viewHi
  }
  return Math.max(lo, Math.min(hi, top))
}

/**
 * An edge band's scroll speed, held to zero once scrolling that way would show no more of the dragged
 * unit's block — past its end there is nowhere to drop, so the rail stops rather than scrolling the
 * block out of view.
 */
export function blockEdgeSpeed(speed: number, slots: readonly Slot[], scrollTop: number, viewport: number): number {
  const last = slots[slots.length - 1]
  if (speed > 0 && last.top + last.height <= scrollTop + viewport) return 0
  if (speed < 0 && slots[0].top >= scrollTop) return 0
  return speed
}

/**
 * The autoscroll speed for a drag, read from the dragged unit's LEADING edge rather than the pointer.
 * The unit is held inside the rail (`cloneTop`), so waiting for the pointer to reach the edge band would
 * leave a dead zone: the unit already stopped at the edge, the rail not yet scrolling. `top` / `bottom` are
 * where the unit would sit if it followed the pointer freely; that can run far past the rail, so the
 * speed is capped at the band's own maximum. A unit taller than the rail has no leading edge inside
 * it, and there the pointer decides, as it does for the tab strip.
 */
export function dragEdgeSpeed(top: number, bottom: number, pointer: number, viewTop: number, viewBottom: number): number {
  const cap = (v: number): number => Math.max(-SCROLL_MAX_SPEED, Math.min(SCROLL_MAX_SPEED, v))
  if (bottom - top >= viewBottom - viewTop) return cap(edgeScrollSpeed(pointer, viewTop, viewBottom))
  const down = edgeScrollSpeed(bottom, viewTop, viewBottom)
  if (down > 0) return cap(down)
  const up = edgeScrollSpeed(top, viewTop, viewBottom)
  return up < 0 ? cap(up) : 0
}

/**
 * Whether any unit other than the dragged one has changed height since its slot was measured — a row
 * arriving in or leaving another folder mid-drag. Its slot, and every slot below it, is then stale.
 * The dragged unit is excluded: a reshape may still be animating it.
 */
export function siblingsResized(heights: readonly number[], slots: readonly Slot[], from: number): boolean {
  return heights.some((h, i) => i !== from && Math.abs(h - slots[i].height) > 0.5)
}

/** The insertion index for a center: how many of the OTHER units have their midpoint above it. */
export function dropIndex(center: number, slots: readonly Slot[], from: number): number {
  let index = 0
  slots.forEach((s, i) => {
    if (i !== from && center > s.top + s.height / 2) index++
  })
  return index
}

/** Where sibling `i` is translated while the gap sits at `to`: one stride toward the unit's old slot. */
export function slotShift(i: number, from: number, to: number, stride: number): number {
  if (i > from && i <= to) return -stride
  if (i < from && i >= to) return stride
  return 0
}

/** The keys a unit moved from `from` to `to` lands between, either null at the block's edge. */
export function dropNeighbors(
  keys: readonly string[],
  from: number,
  to: number
): { above: string | null; below: string | null } {
  const moved = reorderArray(keys.slice(), from, to)
  return { above: moved[to - 1] ?? null, below: moved[to + 1] ?? null }
}
