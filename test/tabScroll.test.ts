import { describe, expect, it } from 'vitest'
import {
  tabEdgeScrollSpeed,
  tabDragScrollRequest,
  tabDragScrollFeedback,
  type TabEdgeMotion,
  type TabScrollRequest,
  tabRuleGeometry,
  tabScrollEdges,
  tabWheelDelta
} from '../src/renderer/lib/tabScroll'

describe('tab rule geometry', () => {
  it('covers the viewport and places one divider at each actual row bottom', () => {
    expect(
      tabRuleGeometry(
        { left: 20, right: 420, top: 17, bottom: 113 },
        [
          { left: 20, right: 180, top: 17, bottom: 48.75 },
          { left: 180, right: 330, top: 17, bottom: 48.75 },
          { left: 180, right: 330, top: 48.75, bottom: 80.5 }
        ],
        0,
        0
      )
    ).toEqual({ width: 400, height: 96, rowBottoms: [31.75, 63.5] })
  })

  it('recovers full content dimensions from clipped rectangles and nonzero scroll offsets', () => {
    expect(
      tabRuleGeometry(
        { left: 20, right: 420, top: 17, bottom: 113 },
        [
          { left: -120.25, right: 59.75, top: -15.5, bottom: 16.5 },
          { left: 379.75, right: 559.75, top: 80.5, bottom: 112.5 }
        ],
        140.25,
        32.5
      )
    ).toEqual({ width: 680, height: 128, rowBottoms: [32, 128] })
  })

  it('preserves the fractional viewport edge instead of rounding it to client dimensions', () => {
    expect(
      tabRuleGeometry(
        { left: 20.25, right: 400.875, top: 4.25, bottom: 36.234375 },
        [{ left: 20.25, right: 180, top: 4.25, bottom: 36.234375 }],
        0,
        0
      )
    ).toEqual({ width: 380.625, height: 31.984375, rowBottoms: [31.984375] })
  })

  it('clears the dividers when no tabs contribute content', () => {
    expect(
      tabRuleGeometry(
        { left: 20, right: 420, top: 17, bottom: 17 },
        [],
        300,
        64
      )
    ).toEqual({ width: 400, height: 0, rowBottoms: [] })
  })
})

describe('tab scroll edges', () => {
  it('shows only the edges with hidden tabs', () => {
    expect(tabScrollEdges(0, 400, 1000)).toEqual({ before: false, after: true })
    expect(tabScrollEdges(270, 400, 1000)).toEqual({ before: true, after: true })
    expect(tabScrollEdges(600, 400, 1000)).toEqual({ before: true, after: false })
  })

  it('has no fades when tabs fit, including after content shrinks', () => {
    expect(tabScrollEdges(0, 400, 400)).toEqual({ before: false, after: false })
    expect(tabScrollEdges(250, 400, 100)).toEqual({ before: false, after: false })
  })

  it('tolerates one pixel of fractional layout rounding at either edge', () => {
    expect(tabScrollEdges(1, 400, 1000)).toEqual({ before: false, after: true })
    expect(tabScrollEdges(1.1, 400, 1000)).toEqual({ before: true, after: true })
    expect(tabScrollEdges(598.9, 400, 1000)).toEqual({ before: true, after: true })
    expect(tabScrollEdges(599, 400, 1000)).toEqual({ before: true, after: false })
  })
})

const wheel = { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false }

describe('tab wheel scrolling', () => {
  it('maps a vertical mouse wheel onto the horizontal axis', () => {
    expect(tabWheelDelta(wheel, 400)).toBe(40)
    expect(tabWheelDelta({ ...wheel, deltaY: -70 }, 400)).toBe(-70)
  })

  it('uses the dominant signed axis without adding diagonal movement', () => {
    expect(tabWheelDelta({ ...wheel, deltaX: -80 }, 400)).toBe(-80)
    expect(tabWheelDelta({ ...wheel, deltaX: 20, deltaY: -40 }, 400)).toBe(-40)
    expect(tabWheelDelta({ ...wheel, deltaX: 40, deltaY: -40 }, 400)).toBe(-40)
  })

  it('converts line and page wheels to pixels', () => {
    expect(tabWheelDelta({ ...wheel, deltaY: 2, deltaMode: 1 }, 500)).toBe(64)
    expect(tabWheelDelta({ ...wheel, deltaY: -1, deltaMode: 2 }, 500)).toBe(-500)
  })

  it('leaves zoom gestures alone', () => {
    expect(tabWheelDelta({ ...wheel, ctrlKey: true }, 400)).toBe(0)
    expect(tabWheelDelta({ ...wheel, metaKey: true }, 400)).toBe(0)
  })
})

describe('drag edge scrolling', () => {
  it('stops in the middle and at the inner boundary of each edge band', () => {
    expect(tabEdgeScrollSpeed(300, 100, 500)).toBe(0)
    expect(tabEdgeScrollSpeed(128, 100, 500)).toBe(0)
    expect(tabEdgeScrollSpeed(472, 100, 500)).toBe(0)
  })

  it('accelerates toward either visible edge, independently of its viewport offset', () => {
    expect(tabEdgeScrollSpeed(100, 100, 500)).toBe(-480)
    expect(tabEdgeScrollSpeed(114, 100, 500)).toBe(-240)
    expect(tabEdgeScrollSpeed(486, 100, 500)).toBe(240)
    expect(tabEdgeScrollSpeed(500, 100, 500)).toBe(480)
  })

  it('keeps opposite edge bands from overlapping in a narrow strip', () => {
    expect(tabEdgeScrollSpeed(110, 100, 120)).toBe(0)
    expect(tabEdgeScrollSpeed(105, 100, 120)).toBe(-240)
    expect(tabEdgeScrollSpeed(115, 100, 120)).toBe(240)
  })
})


describe('drag scroll motion', () => {
  it('stops at rounded endpoints with one pixel of tolerance', () => {
    expect(tabDragScrollRequest(null, 'strip', 480, 16, 2132.92285, 2133)).toBeNull()
    expect(tabDragScrollRequest(null, 'strip', -480, 16, 0.5, 2133)).toBeNull()
    expect(tabDragScrollRequest(null, 'strip', 480, 16, 2131.9, 2133)?.delta).toBeCloseTo(7.68)
    expect(tabDragScrollRequest(null, 'strip', 0, 16, 100, 500)).toBeNull()
  })
  it('discards residual movement on direction changes and new targets', () => {
    const previous: TabEdgeMotion<string> = { target: 'strip', direction: 1, remainder: 0.4 }
    expect(tabDragScrollRequest(previous, 'strip', 480, 16, 100, 500)?.delta).toBeCloseTo(8.08)
    expect(tabDragScrollRequest(previous, 'strip', -480, 16, 100, 500)?.delta).toBeCloseTo(-7.68)
    expect(tabDragScrollRequest(previous, 'other-strip', 480, 16, 100, 500)?.delta).toBeCloseTo(7.68)
    expect(tabDragScrollRequest(null, 'strip', 480, 16, 100, 500)?.delta).toBeCloseTo(7.68)
  })
  it('discards movement clamped by the browser instead of storing a backlog', () => {
    expect(tabDragScrollFeedback({ target: 'strip', direction: 1, delta: 12 }, 100, 100, 0.5)).toBeNull()
    expect(tabDragScrollFeedback({ target: 'strip', direction: 1, delta: 12 }, 100, 106, 0.5)).toBeNull()
    expect(tabDragScrollFeedback({ target: 'strip', direction: -1, delta: -12 }, 100, 94, 0.5)).toBeNull()
    expect(tabDragScrollFeedback({ target: 'strip', direction: 1, delta: 0 }, 100, 100, 0.5)).toEqual({ target: 'strip', direction: 1, remainder: 0 })
  })
  it('accumulates slow subpixel movement until the browser can apply it', () => {
    let state: TabEdgeMotion<string> | null = null
    let position = 100
    for (let i = 0; i < 20; i++) {
      const request: TabScrollRequest<string> = tabDragScrollRequest(state, 'strip', 3, 16, position, 500)!
      const next = Math.floor((position + request.delta) * 2) / 2
      state = tabDragScrollFeedback(request, position, next, 0.5)
      expect(state).not.toBeNull()
      expect(Math.abs(state!.remainder)).toBeLessThan(0.5)
      position = next
    }
    expect(position).toBe(100.5)
    expect(state!.remainder).toBeCloseTo(0.46)
  })
  it('bounds delayed frames and tolerates a zero-duration first frame', () => {
    expect(tabDragScrollRequest(null, 'strip', 480, 1000, 100, 500)?.delta).toBeCloseTo(15.36)
    expect(tabDragScrollRequest(null, 'strip', 480, -1, 100, 500)?.delta).toBe(0)
  })
})
