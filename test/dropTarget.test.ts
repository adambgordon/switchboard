import { describe, expect, it } from 'vitest'
import {
  pointInRect,
  groupDragFollowerIndices,
  groupDragIndices,
  isGroupOriginDrop,
  tabCaretIndex,
  tabCaretPosition,
  tabDropIndex,
  type TabRect
} from '../src/renderer/lib/dropTarget'

/**
 * Where a dragged tab lands.
 *
 * The happy path — pointer squarely over a gap in a single row — is the part least worth testing; it
 * is also the only part a person exercises while checking the feature by hand. What actually decides
 * whether dragging feels right is the edges: a pointer between rows, past the end of a ragged last
 * row, or outside the strip. Each of those has to resolve to a specific index, and a wrong one
 * reorders a tab the user was merely passing over.
 */

/** A row of `count` tabs, each `w` wide, starting at x=0, on a row `h` tall at `top`. */
function row(top: number, count: number, w = 100, h = 32): TabRect[] {
  return Array.from({ length: count }, (_, i) => ({
    top,
    bottom: top + h,
    left: i * w,
    right: (i + 1) * w
  }))
}

describe('scrolled tab geometry', () => {
  const strip = { left: 250, right: 650, top: 70, bottom: 102 }
  const tabs = [
    { left: 90, right: 190, top: 70, bottom: 102 },
    { left: 190, right: 360, top: 70, bottom: 102 },
    { left: 360, right: 470, top: 70, bottom: 102 },
    { left: 470, right: 680, top: 70, bottom: 102 },
    { left: 680, right: 830, top: 70, bottom: 102 }
  ]

  it('counts offscreen and unequal-width tabs while excluding a scattered carried group', () => {
    expect(tabDropIndex(tabs, 580, 86, [0, 2])).toBe(2)
    expect(tabCaretIndex(2, tabs.length, [0, 2])).toBe(4)
  })

  it('places leading and trailing carets in content coordinates', () => {
    expect(tabCaretPosition(tabs[3], strip, false, 160, 0)).toEqual({ x: 380, y: 0 })
    expect(tabCaretPosition(tabs[4], strip, true, 160, 0)).toEqual({ x: 740, y: 0 })
  })

  it('also retains the wrapped strip’s vertical scroll offset', () => {
    const tab = { left: 320, right: 470, top: 102, bottom: 134 }
    expect(tabCaretPosition(tab, strip, false, 0, 64)).toEqual({ x: 70, y: 96 })
  })
})

describe('tabDropIndex — a single row', () => {
  const tabs = row(0, 3) // [0..100] [100..200] [200..300], y 0..32

  it('is 0 in the left half of the first tab', () => {
    expect(tabDropIndex(tabs, 10, 16)).toBe(0)
  })

  it('advances past each tab whose midpoint the pointer has crossed', () => {
    expect(tabDropIndex(tabs, 60, 16)).toBe(1)
    expect(tabDropIndex(tabs, 160, 16)).toBe(2)
    expect(tabDropIndex(tabs, 260, 16)).toBe(3)
  })

  it('is the end when the pointer is past the last tab', () => {
    // Ragged right edge: past the end of a row is empty strip, and it must mean "append", not "row 0".
    expect(tabDropIndex(tabs, 5000, 16)).toBe(3)
  })

  it('uses the midpoint, not the edge', () => {
    // One pixel either side of tab 1's midpoint (150). A version comparing against `left` or `right`
    // would put both on the same side, so this is what pins the midpoint specifically.
    expect(tabDropIndex(tabs, 149, 16)).toBe(1)
    expect(tabDropIndex(tabs, 151, 16)).toBe(2)
    // And exactly ON it. Reachable in one pixel of travel, so it needs a defined winner rather than
    // whichever way the comparison happens to lean — the lower index, matching how a pointer on the
    // seam between two ROWS resolves upward.
    expect(tabDropIndex(tabs, 150, 16)).toBe(1)
  })
})

describe('tabDropIndex — the dragged tab does not count itself', () => {
  const tabs = row(0, 3)

  it('returns the dragged index when the pointer has not left its own slot', () => {
    // The no-op result. Callers compare against skipIndex to decide whether to move at all, so this
    // has to be exactly equal rather than merely close.
    expect(tabDropIndex(tabs, 60, 16, 1)).toBe(1)
  })

  it('skips the dragged tab when counting, so indices stay comparable', () => {
    // Dragging tab 0 rightwards. Without the skip, crossing tab 0's own midpoint would already count
    // it and every target would be one too high.
    expect(tabDropIndex(tabs, 10, 16, 0)).toBe(0)
    expect(tabDropIndex(tabs, 160, 16, 0)).toBe(1)
    expect(tabDropIndex(tabs, 260, 16, 0)).toBe(2)
  })

  it('skips a whole scattered group without removing its geometry', () => {
    const many = row(0, 6)
    expect(tabDropIndex(many, 550, 16, [1, 3, 4])).toBe(2)
    expect(tabDropIndex(many, 600, 16, [1, 3, 4])).toBe(3)
  })
})

describe('tabDropIndex — wrapped rows', () => {
  // Two full rows and a ragged third: 3 + 3 + 1 tabs.
  const tabs = [...row(0, 3), ...row(32, 3), ...row(64, 1)]

  it('counts every tab in the rows above the pointer', () => {
    // Left edge of row 1 is index 3 — all of row 0 precedes it regardless of x.
    expect(tabDropIndex(tabs, 10, 48)).toBe(3)
    // x=160 has crossed row 1's first TWO midpoints (50 and 150), so 3 + 2. Same x on a single row
    // gives 2 (above), which is what makes this an assertion about the row offset rather than about x.
    expect(tabDropIndex(tabs, 160, 48)).toBe(5)
  })

  it('reaches the last row, and the end of the strip', () => {
    expect(tabDropIndex(tabs, 10, 80)).toBe(6)
    expect(tabDropIndex(tabs, 90, 80)).toBe(7)
  })

  it('ignores x once the row is decided', () => {
    // Far past the ragged third row's only tab still means "end of row 2", never "end of row 0".
    expect(tabDropIndex(tabs, 5000, 80)).toBe(7)
    // And the same x one row up lands at the end of THAT row instead.
    expect(tabDropIndex(tabs, 5000, 48)).toBe(6)
  })

  it('resolves a pointer between two rows upward, deterministically', () => {
    // Row 0 is 0..32 and row 1 is 32..64, so y=32 is inside row 1's band and 0px from row 0's — an
    // exact tie. Whichever way it goes it must be the SAME way every time, or a pointer hovering on
    // the seam alternates between two different destinations. Upward, by the strict comparison.
    expect(tabDropIndex(tabs, 10, 32)).toBe(0)
  })

  it('clamps above the strip to the first row and below it to the last', () => {
    // Dragging out of the strip vertically — toward the title bar, or down into the transcript. The
    // hook decides whether that means "detach"; if it means "reorder", it must not mean "index 0".
    expect(tabDropIndex(tabs, 160, -500)).toBe(2)
    expect(tabDropIndex(tabs, 90, 5000)).toBe(7)
  })

  it('clamps ABOVE the strip by distance, not by falling back to the first rect', () => {
    // The assertion above cannot tell those two apart. Its rects happen to start with the top row, so
    // an implementation that measured no distance at all and simply took the first row it enumerated
    // would give the same answer — two different behaviours, one output. Listing the BOTTOM row first
    // separates them: measured distance still resolves upward to the top row, while a first-rect
    // fallback lands on the bottom one.
    const bottomFirst = [...row(64, 1), ...row(0, 3)]
    expect(tabDropIndex(bottomFirst, 10, -500)).toBe(0)
    // And the mirror, so neither direction can be the accidental one.
    const topFirst = [...row(0, 3), ...row(64, 1)]
    expect(tabDropIndex(topFirst, 10, 5000)).toBe(3)
  })
})

describe('tabDropIndex — degenerate inputs', () => {
  it('is 0 for an empty strip', () => {
    // The real case: dropping into the other pane's strip when that pane has no tabs at all.
    expect(tabDropIndex([], 100, 100)).toBe(0)
  })

  it('does not assume the rects are in reading order', () => {
    // Same three tabs, shuffled. Every tab is classified against the resolved row rather than by its
    // array position, so the answer cannot depend on the caller's enumeration order.
    const tabs = row(0, 3)
    const shuffled = [tabs[2], tabs[0], tabs[1]]
    expect(tabDropIndex(shuffled, 160, 16)).toBe(2)
  })

  it('resolves an exact row tie upward even when the bottom row is listed first', () => {
    const bottomFirst = [...row(64, 2), ...row(0, 2)]
    expect(tabDropIndex(bottomFirst, 10, 48)).toBe(0)
  })
})

describe('tabCaretIndex', () => {
  it('keeps leftward boundaries unchanged', () => {
    expect(tabCaretIndex(1, 4, 2)).toBe(1)
  })

  it('skips the dragged rectangle for a rightward middle insertion', () => {
    expect(tabCaretIndex(2, 4, 1)).toBe(3)
  })

  it('paints the original slot at the dragged tab’s left edge', () => {
    expect(tabCaretIndex(1, 4, 1)).toBe(1)
  })

  it('maps a post-removal end insertion to the trailing strip boundary', () => {
    expect(tabCaretIndex(3, 4, 1)).toBe(4)
  })

  it('does not translate a different strip with no skipped rectangle', () => {
    expect(tabCaretIndex(2, 4)).toBe(2)
  })

  it('maps a scattered group against the unchanged source rectangles', () => {
    expect(tabCaretIndex(1, 6, [1, 3, 4], 1)).toBe(1)
    expect(tabCaretIndex(2, 6, [1, 3, 4], 1)).toBe(5)
    expect(tabCaretIndex(3, 6, [1, 3, 4], 1)).toBe(6)
  })
})

describe('groupDragIndices', () => {
  it('returns a contiguous selection in source order', () => {
    expect(groupDragIndices(['A', 'B', 'C', 'D'], ['B', 'C'])).toEqual([1, 2])
  })

  it('returns a scattered selection in source order', () => {
    expect(groupDragIndices(['A', 'B', 'C', 'D', 'E'], ['D', 'B', 'E'])).toEqual([1, 3, 4])
  })

  it('returns no indices when none of the carried ids belong to this strip', () => {
    expect(groupDragIndices(['A', 'B'], ['X'])).toEqual([])
  })
})

describe('groupDragFollowerIndices', () => {
  it('marks one follower after a contiguous selected run', () => {
    expect(groupDragFollowerIndices([1, 2, 3], [0, 0, 0, 0, 0, 0])).toEqual([4])
  })

  it('marks the follower after every scattered selected run', () => {
    expect(groupDragFollowerIndices([1, 3, 4], [0, 0, 0, 0, 0, 0])).toEqual([2, 5])
  })

  it('does not invent a follower past the final tab', () => {
    expect(groupDragFollowerIndices([2, 3], [0, 0, 0, 0])).toEqual([])
  })

  it('does not paint a follower that wrapped onto another row', () => {
    expect(groupDragFollowerIndices([1], [0, 0, 32, 32])).toEqual([])
  })
})

describe('isGroupOriginDrop', () => {
  it('treats only the group’s leftmost source position as the no-op origin', () => {
    expect(isGroupOriginDrop(0, 1, { pane: 0, index: 1 })).toBe(true)
    expect(isGroupOriginDrop(0, 1, { pane: 0, index: 2 })).toBe(false)
    expect(isGroupOriginDrop(0, 1, { pane: 1, index: 1 })).toBe(false)
  })
})

describe('pointInRect', () => {
  const r: TabRect = { top: 10, bottom: 20, left: 30, right: 40 }

  it('includes the boundary', () => {
    expect(pointInRect(r, 30, 10)).toBe(true)
    expect(pointInRect(r, 40, 20)).toBe(true)
  })

  it('excludes points outside on each axis independently', () => {
    // Each miss varies ONE axis, so an implementation that tested only x or only y fails here.
    expect(pointInRect(r, 29, 15)).toBe(false)
    expect(pointInRect(r, 41, 15)).toBe(false)
    expect(pointInRect(r, 35, 9)).toBe(false)
    expect(pointInRect(r, 35, 21)).toBe(false)
  })
})
