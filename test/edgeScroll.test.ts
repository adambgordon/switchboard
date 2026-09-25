import { describe, expect, it } from 'vitest'
import {
  edgeScrollSpeed,
  dragScrollRequest,
  dragScrollFeedback,
  type EdgeMotion,
  type ScrollRequest
} from '../src/renderer/lib/edgeScroll'

describe('drag edge scrolling', () => {
  it('stops in the middle and at the inner boundary of each edge band', () => {
    expect(edgeScrollSpeed(300, 100, 500)).toBe(0)
    expect(edgeScrollSpeed(128, 100, 500)).toBe(0)
    expect(edgeScrollSpeed(472, 100, 500)).toBe(0)
  })

  it('accelerates toward either visible edge, independently of its viewport offset', () => {
    expect(edgeScrollSpeed(100, 100, 500)).toBe(-480)
    expect(edgeScrollSpeed(114, 100, 500)).toBe(-240)
    expect(edgeScrollSpeed(486, 100, 500)).toBe(240)
    expect(edgeScrollSpeed(500, 100, 500)).toBe(480)
  })

  it('keeps opposite edge bands from overlapping in a narrow strip', () => {
    expect(edgeScrollSpeed(110, 100, 120)).toBe(0)
    expect(edgeScrollSpeed(105, 100, 120)).toBe(-240)
    expect(edgeScrollSpeed(115, 100, 120)).toBe(240)
  })
})


describe('drag scroll motion', () => {
  it('stops at rounded endpoints with one pixel of tolerance', () => {
    expect(dragScrollRequest(null, 'strip', 480, 16, 2132.92285, 2133)).toBeNull()
    expect(dragScrollRequest(null, 'strip', -480, 16, 0.5, 2133)).toBeNull()
    expect(dragScrollRequest(null, 'strip', 480, 16, 2131.9, 2133)?.delta).toBeCloseTo(7.68)
    expect(dragScrollRequest(null, 'strip', 0, 16, 100, 500)).toBeNull()
  })
  it('discards residual movement on direction changes and new targets', () => {
    const previous: EdgeMotion<string> = { target: 'strip', direction: 1, remainder: 0.4 }
    expect(dragScrollRequest(previous, 'strip', 480, 16, 100, 500)?.delta).toBeCloseTo(8.08)
    expect(dragScrollRequest(previous, 'strip', -480, 16, 100, 500)?.delta).toBeCloseTo(-7.68)
    expect(dragScrollRequest(previous, 'other-strip', 480, 16, 100, 500)?.delta).toBeCloseTo(7.68)
    expect(dragScrollRequest(null, 'strip', 480, 16, 100, 500)?.delta).toBeCloseTo(7.68)
  })
  it('discards movement clamped by the browser instead of storing a backlog', () => {
    expect(dragScrollFeedback({ target: 'strip', direction: 1, delta: 12 }, 100, 100, 0.5)).toBeNull()
    expect(dragScrollFeedback({ target: 'strip', direction: 1, delta: 12 }, 100, 106, 0.5)).toBeNull()
    expect(dragScrollFeedback({ target: 'strip', direction: -1, delta: -12 }, 100, 94, 0.5)).toBeNull()
    expect(dragScrollFeedback({ target: 'strip', direction: 1, delta: 0 }, 100, 100, 0.5)).toEqual({ target: 'strip', direction: 1, remainder: 0 })
  })
  it('accumulates slow subpixel movement until the browser can apply it', () => {
    let state: EdgeMotion<string> | null = null
    let position = 100
    for (let i = 0; i < 20; i++) {
      const request: ScrollRequest<string> = dragScrollRequest(state, 'strip', 3, 16, position, 500)!
      const next = Math.floor((position + request.delta) * 2) / 2
      state = dragScrollFeedback(request, position, next, 0.5)
      expect(state).not.toBeNull()
      expect(Math.abs(state!.remainder)).toBeLessThan(0.5)
      position = next
    }
    expect(position).toBe(100.5)
    expect(state!.remainder).toBeCloseTo(0.46)
  })
  it('bounds delayed frames and tolerates a zero-duration first frame', () => {
    expect(dragScrollRequest(null, 'strip', 480, 1000, 100, 500)?.delta).toBeCloseTo(15.36)
    expect(dragScrollRequest(null, 'strip', 480, -1, 100, 500)?.delta).toBe(0)
  })
})
