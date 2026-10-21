import { describe, expect, it } from 'vitest'
import { titlebarInsetFor, trafficLightPositionFor } from '../src/main/trafficLights'

// Two ⌘− steps and two ⌘+ steps: Chromium's zoom levels are powers of 1.2.
const OUT_2 = 1.2 ** -2
const OUT_1 = 1.2 ** -1
const IN_2 = 1.2 ** 2

/** Where the title bar's first control starts, in window points, relative to the lights' left edge. */
const clearance = (factor: number) => titlebarInsetFor(factor) * factor - trafficLightPositionFor(factor).x

describe('titlebarInsetFor', () => {
  it('is the resting 90px at 100% and when zoomed in', () => {
    expect(titlebarInsetFor(1)).toBe(90)
    expect(titlebarInsetFor(1.2)).toBe(90)
    expect(titlebarInsetFor(IN_2)).toBe(90)
  })

  it('keeps the 100% distance from the lights when zoomed out, where scaling would slide under them', () => {
    // At 100% the first control starts 76pt past the lights' left edge (90 - 14).
    expect(clearance(1)).toBeCloseTo(76, 6)
    expect(clearance(OUT_1)).toBeCloseTo(76, 6)
    expect(clearance(OUT_2)).toBeCloseTo(76, 6)
    // Scaling the 90px inset, as before, would have left only 52.5pt at two steps out.
    expect(90 * OUT_2 - trafficLightPositionFor(OUT_2).x).toBeLessThan(55)
    expect(titlebarInsetFor(OUT_2)).toBeCloseTo((10 + 76) / OUT_2, 6)
  })
})
