import { describe, expect, it } from 'vitest'
import {
  blockEdgeSpeed,
  clampCenter,
  cloneTop,
  contentY,
  dragEdgeSpeed,
  dragStride,
  dropIndex,
  dropNeighbors,
  siblingsResized,
  slotShift
} from '../src/renderer/lib/blockReorder'

// Unequal heights and gaps, so a rule that assumes a uniform row cannot pass.
const slots = [
  { top: 10, height: 24 }, // mid 22
  { top: 37, height: 24 }, // mid 49; gap above 3
  { top: 66, height: 40 }, // mid 86; gap above 5
  { top: 111, height: 24 } // mid 123; gap above 5
]

describe('contentY', () => {
  it('measures from the container top and adds what has scrolled past it', () => {
    expect(contentY(250, 100, 0)).toBe(150)
    expect(contentY(250, 100, 400)).toBe(550)
  })
})

describe('dragStride', () => {
  it('is the unit height plus the gap below it', () => {
    expect(dragStride(slots, 0)).toBe(27)
    expect(dragStride(slots, 1)).toBe(29)
  })

  it('takes the gap above for the last unit, which has none below', () => {
    expect(dragStride(slots, 3)).toBe(29)
  })

  it('is just the height for a lone unit', () => {
    expect(dragStride([{ top: 0, height: 30 }], 0)).toBe(30)
  })
})

describe('clampCenter', () => {
  it('holds the center within the block', () => {
    expect(clampCenter(-500, slots)).toBe(10)
    expect(clampCenter(9000, slots)).toBe(135)
    expect(clampCenter(70, slots)).toBe(70)
  })
})

describe('dropIndex', () => {
  it('counts the other units whose midpoint is above the center', () => {
    // Dragging unit 0 down: past unit 1's midpoint but not unit 2's.
    expect(dropIndex(50, slots, 0)).toBe(1)
    expect(dropIndex(48, slots, 0)).toBe(0)
    expect(dropIndex(87, slots, 0)).toBe(2)
  })

  it('never counts the dragged unit itself', () => {
    // Unit 2 held in place: units 0 and 1 are above it, and its own midpoint must not add a third.
    expect(dropIndex(86.5, slots, 2)).toBe(2)
    expect(dropIndex(124, slots, 2)).toBe(3)
  })

  it('reaches both ends from a clamped center', () => {
    expect(dropIndex(clampCenter(-500, slots), slots, 2)).toBe(0)
    expect(dropIndex(clampCenter(9000, slots), slots, 0)).toBe(3)
  })
})

describe('slotShift', () => {
  it('pulls the units between the old and new slot up when dragging down', () => {
    expect([0, 1, 2, 3].map((i) => slotShift(i, 1, 3, 27))).toEqual([0, 0, -27, -27])
  })

  it('pushes them down when dragging up', () => {
    expect([0, 1, 2, 3].map((i) => slotShift(i, 3, 1, 27))).toEqual([0, 27, 27, 0])
  })

  it('moves nothing while the unit is over its own slot', () => {
    expect([0, 1, 2, 3].map((i) => slotShift(i, 2, 2, 27))).toEqual([0, 0, 0, 0])
  })
})

describe('dropNeighbors', () => {
  const keys = ['a', 'b', 'c', 'd', 'e']

  it('reports the units around the new slot, dragging down', () => {
    expect(dropNeighbors(keys, 1, 3)).toEqual({ above: 'd', below: 'e' })
  })

  it('reports the units around the new slot, dragging up', () => {
    expect(dropNeighbors(keys, 3, 1)).toEqual({ above: 'a', below: 'b' })
  })

  it('is null above at the top and below at the bottom', () => {
    expect(dropNeighbors(keys, 2, 0)).toEqual({ above: null, below: 'a' })
    expect(dropNeighbors(keys, 1, 4)).toEqual({ above: 'e', below: null })
  })
})

describe('cloneTop', () => {
  const all = { top: -1000, bottom: 1000 }

  it('follows the pointer inside the block', () => {
    expect(cloneTop(50, slots, 24, 12, all)).toBe(50)
  })

  it('stops the overshoot past either end', () => {
    // First slot at 10, so no higher than 10 - 12; last ends at 135, so no lower than 135 - 24 + 12.
    expect(cloneTop(-400, slots, 24, 12, all)).toBe(-2)
    expect(cloneTop(900, slots, 24, 12, all)).toBe(123)
  })

  it('stays wholly inside the visible rail while the block runs past its edge', () => {
    // On screen: content 0–80. The block continues to 135, but the clone stops at 80 - 24.
    expect(cloneTop(900, slots, 24, 12, { top: 0, bottom: 80 })).toBe(56)
    // Scrolled so the view starts at 60: no higher than 60, though the block starts at 10.
    expect(cloneTop(-400, slots, 24, 12, { top: 60, bottom: 200 })).toBe(60)
  })

  it('falls back to the block alone for a unit taller than the view', () => {
    expect(cloneTop(900, slots, 120, 12, { top: 0, bottom: 80 })).toBe(27)
  })
})

describe('blockEdgeSpeed', () => {
  // The block spans content 10–135.
  it('scrolls down while more of the block lies below the viewport', () => {
    expect(blockEdgeSpeed(300, slots, 0, 100)).toBe(300)
  })

  it('stops scrolling down once the block has fully scrolled into view', () => {
    expect(blockEdgeSpeed(300, slots, 35, 100)).toBe(0)
    expect(blockEdgeSpeed(300, slots, 34, 100)).toBe(300)
  })

  it('scrolls up only while the block starts above the viewport', () => {
    expect(blockEdgeSpeed(-300, slots, 11, 100)).toBe(-300)
    expect(blockEdgeSpeed(-300, slots, 10, 100)).toBe(0)
  })

  it('passes a resting pointer through', () => {
    expect(blockEdgeSpeed(0, slots, 20, 100)).toBe(0)
  })
})

describe('dragEdgeSpeed', () => {
  // A 500px-tall rail from y=100 to y=600; the edge band is 28px deep.
  it('scrolls once the dragged unit reaches the band, wherever the pointer is', () => {
    // The pointer is 20px down a 60px unit, well above the bottom band; the unit's bottom is in it.
    expect(dragEdgeSpeed(526, 586, 546, 100, 600)).toBeCloseTo(240)
  })

  it('reads the top edge when the unit rises into the upper band', () => {
    expect(dragEdgeSpeed(114, 174, 160, 100, 600)).toBeCloseTo(-240)
  })

  it('scrolls a short unit near the top at its top edge, even with its bottom in the band too', () => {
    // A 20px unit whose bottom is also inside the upper band: 480 * (128 - 105) / 28, not its bottom's
    // far slower 480 * (128 - 125) / 28.
    expect(dragEdgeSpeed(105, 125, 110, 100, 600)).toBeCloseTo((-480 * 23) / 28)
  })

  it('is still while the unit is clear of both bands', () => {
    expect(dragEdgeSpeed(300, 360, 320, 100, 600)).toBe(0)
  })

  it('caps the speed when the unit would run far past the rail', () => {
    expect(dragEdgeSpeed(900, 960, 920, 100, 600)).toBe(480)
    expect(dragEdgeSpeed(-400, -340, -380, 100, 600)).toBe(-480)
  })

  it('lets the pointer decide for a unit taller than the rail', () => {
    // An 800px folder spans both bands; only the pointer, mid-rail, says whether to scroll.
    expect(dragEdgeSpeed(0, 800, 350, 100, 600)).toBe(0)
    expect(dragEdgeSpeed(0, 800, 586, 100, 600)).toBeCloseTo(240)
  })
})

describe('siblingsResized', () => {
  const heights = slots.map((s) => s.height)

  it('is false while every unit keeps its measured height', () => {
    expect(siblingsResized(heights, slots, 1)).toBe(false)
  })

  it('notices a sibling that grew — a row arriving in another folder', () => {
    expect(siblingsResized([24, 24, 64, 24], slots, 1)).toBe(true)
  })

  it('ignores the dragged unit itself, which a fold may still be animating', () => {
    expect(siblingsResized([24, 90, 40, 24], slots, 1)).toBe(false)
  })

  it('tolerates sub-pixel rounding', () => {
    expect(siblingsResized([24.4, 24, 40, 24], slots, 1)).toBe(false)
  })
})
