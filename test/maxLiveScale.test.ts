import { describe, expect, it } from 'vitest'
import {
  SLIDER_STEPS,
  positionForValue,
  valueForPosition
} from '../src/renderer/lib/maxLiveScale'

// The shipped bounds: min 2, default 8, max 16 — asymmetric about the default (6 below, 8 above),
// which is the whole reason the scale is piecewise rather than linear.
const MIN = 2
const MID = 8
const MAX = 16

const pos = (v: number): number => positionForValue(v, MIN, MID, MAX)
const val = (p: number): number => valueForPosition(p, MIN, MID, MAX)

describe('maxLiveScale', () => {
  it('puts the default at the exact visual midpoint', () => {
    expect(pos(MID)).toBe(SLIDER_STEPS / 2)
  })

  it('pins the bounds to the ends of the track', () => {
    expect(pos(MIN)).toBe(0)
    expect(pos(MAX)).toBe(SLIDER_STEPS)
    expect(val(0)).toBe(MIN)
    expect(val(SLIDER_STEPS)).toBe(MAX)
  })

  it('round-trips every value in range', () => {
    // This is the property that matters: React re-renders the input from the STORED value, so if any
    // value mapped to a position that mapped back to a different value, the thumb would jump on commit.
    for (let v = MIN; v <= MAX; v += 1) {
      expect(val(pos(v))).toBe(v)
    }
  })

  it('reaches every value in range from some position', () => {
    const reachable = new Set<number>()
    for (let p = 0; p <= SLIDER_STEPS; p += 1) reachable.add(val(p))
    for (let v = MIN; v <= MAX; v += 1) expect(reachable.has(v)).toBe(true)
  })

  it('never decreases as the position advances', () => {
    let prev = val(0)
    for (let p = 1; p <= SLIDER_STEPS; p += 1) {
      const here = val(p)
      expect(here).toBeGreaterThanOrEqual(prev)
      prev = here
    }
  })

  it('spends each half of the track on its own side of the default', () => {
    for (let v = MIN; v < MID; v += 1) expect(pos(v)).toBeLessThan(SLIDER_STEPS / 2)
    for (let v = MID + 1; v <= MAX; v += 1) expect(pos(v)).toBeGreaterThan(SLIDER_STEPS / 2)
  })

  it('clamps positions from outside the track', () => {
    expect(val(-40)).toBe(MIN)
    expect(val(SLIDER_STEPS + 40)).toBe(MAX)
  })

  it('survives a default sitting on either bound without dividing by zero', () => {
    // Degenerate configs can't arise from CONFIG, so this asserts the INVARIANTS rather than exact
    // positions: a collapsed half must not produce NaN or run off the track. (Where such a config puts
    // its endpoint is arbitrary — with mid === max the whole usable range is the lower half, so the top
    // value legitimately lands mid-track.)
    for (const [v, min, mid, max] of [
      [2, 2, 2, 16],
      [9, 2, 2, 16],
      [16, 2, 16, 16],
      [2, 2, 16, 16],
      [5, 5, 5, 5]
    ]) {
      const p = positionForValue(v, min, mid, max)
      expect(Number.isFinite(p)).toBe(true)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(SLIDER_STEPS)
    }
  })
})
