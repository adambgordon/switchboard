/**
 * Where a dragged tab would land: the insertion index for a pointer over a tab strip.
 *
 * Pulled out of the drag hook because it is arithmetic with edge cases, and because the edges are the
 * whole difficulty — a pointer between two rows, past the end of a short last row, or outside the
 * strip entirely all have to resolve to *some* index, and picking the wrong one silently reorders a
 * tab the user was only passing over. Inside a pointer handler none of that is reachable by a test.
 *
 * The strip WRAPS, so this is two-dimensional: pick the row from y, then the gap from x. That is the
 * only real difference from the rail's vertical reorder, and it is why the two do not share code —
 * the rail is a single column with a fixed stride, and generalising it would make the part that must
 * not regress conditional on a case it never has.
 */

/** The geometry this needs from a tab — a `DOMRect` satisfies it structurally. */
export interface TabRect {
  top: number
  bottom: number
  left: number
  right: number
}

/** Convert viewport rectangles to the scroller's content coordinates on both axes. */
export function tabCaretPosition(
  tab: TabRect,
  strip: TabRect,
  atEnd: boolean,
  scrollLeft: number,
  scrollTop: number
) {
  return {
    x: (atEnd ? tab.right : tab.left) - strip.left + scrollLeft,
    y: tab.top - strip.top + scrollTop
  }
}

/**
 * Insertion index for a pointer at (x, y) over `rects`, in reading order.
 *
 * `skipIndex` is the tab being dragged. It keeps its slot in the layout while it moves (so the strip
 * does not reflow under the pointer), so its rect is still present and must not count toward its own
 * destination — exactly as the rail excludes the row it is dragging. The result is directly comparable
 * to `skipIndex`: equal means the drag ended where it started and nothing should move.
 *
 * Returns a value in `0..rects.length`. Order of `rects` is not assumed: every tab is classified
 * against the resolved row rather than by its position in the array.
 */
export function tabDropIndex(
  rects: TabRect[],
  x: number,
  y: number,
  skip: number | readonly number[] = -1
): number {
  const skipped = new Set(typeof skip === 'number' ? (skip >= 0 ? [skip] : []) : skip)
  // An empty strip needs no special case and deliberately does not get one: with no rects there are no
  // rows to resolve and nothing to count, so both loops below are skipped and the result is 0 — which
  // is the right answer (dropping into a pane with no tabs inserts at the front). An early return here
  // would read as load-bearing while changing nothing.

  // Rows are exact rather than approximate: tabs are uniform height and wrap, so every tab in a row
  // shares a `top`. No clustering tolerance needed, and none wanted — a tolerance would be a second
  // threshold to tune with nothing to tune it against.
  const tops = [...new Set(rects.map((r) => r.top))].sort((a, b) => a - b)

  // Resolve the pointer to a row. Being OUTSIDE every band is the common case, not the exception: the
  // pointer spends most of a drag slightly above or below the row it is aiming at, and it may leave
  // the strip completely. Nearest-band keeps every one of those aiming at something, so a drag past
  // the bottom edge targets the last row instead of falling back to index 0 — which would fling the
  // tab to the front of the strip.
  let row = tops[0]
  let nearest = Infinity
  for (const top of tops) {
    const band = rects.find((r) => r.top === top)!
    const distance = y < band.top ? band.top - y : y > band.bottom ? y - band.bottom : 0
    // Strictly less-than, so an exact tie between two rows resolves UPWARD. Ties are reachable — a
    // pointer exactly on the boundary between two rows is one pixel of travel — so the tie needs a
    // defined winner rather than whichever row happened to be enumerated last.
    if (distance < nearest) {
      nearest = distance
      row = top
    }
  }

  let index = 0
  for (let i = 0; i < rects.length; i++) {
    if (skipped.has(i)) continue
    const r = rects[i]
    // A tab above the pointer's row always precedes it; one below never does.
    if (r.top < row) index++
    else if (r.top === row && x > (r.left + r.right) / 2) index++
  }
  return index
}

/** Translate a post-removal drop index back to a boundary in the original rectangle list. */
export function tabCaretIndex(
  dropIndex: number,
  rectCount: number,
  skip: number | readonly number[] = -1,
  originIndex?: number
): number {
  const skipped = new Set(typeof skip === 'number' ? (skip >= 0 ? [skip] : []) : skip)
  if (skipped.size === 0) return Math.max(0, Math.min(dropIndex, rectCount))
  const origin = originIndex ?? Math.min(...skipped)
  let homeIndex = 0
  for (let index = 0; index < origin; index += 1) {
    if (!skipped.has(index)) homeIndex += 1
  }
  if (dropIndex === homeIndex) return origin

  let remainingIndex = 0
  for (let index = 0; index < rectCount; index += 1) {
    if (skipped.has(index)) continue
    if (remainingIndex === dropIndex) return index
    remainingIndex += 1
  }
  return rectCount
}

/** Original indices of a carried group, in source order. */
export function groupDragIndices(
  order: readonly string[],
  carrying: readonly string[]
): number[] {
  const selected = new Set(carrying)
  const indices: number[] = []
  for (let index = 0; index < order.length; index += 1) {
    if (selected.has(order[index])) indices.push(index)
  }
  return indices
}

/** First visible tab after each selected run, whose missing left rule must be repainted. */
export function groupDragFollowerIndices(
  selectedIndices: readonly number[],
  rowTops: readonly number[]
): number[] {
  const selected = new Set(selectedIndices)
  const followers: number[] = []
  for (const index of selected) {
    const follower = index + 1
    if (
      follower < rowTops.length &&
      !selected.has(follower) &&
      rowTops[index] === rowTops[follower]
    ) {
      followers.push(follower)
    }
  }
  return followers
}

export function isGroupOriginDrop(
  sourcePane: number,
  originIndex: number,
  destination: { pane: number; index: number }
): boolean {
  return destination.pane === sourcePane && destination.index === originIndex
}

/** Whether a point is inside a rect — used to decide which strip, if any, a drag is over. */
export function pointInRect(rect: TabRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}
