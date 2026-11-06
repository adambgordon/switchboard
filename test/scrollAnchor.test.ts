import { describe, expect, it } from 'vitest'
import { anchorPoint, anchoredScrollTop } from '../src/renderer/lib/scrollAnchor'

describe('scroll anchoring across reflow', () => {
  it('keeps the same passage of a tall element at the edge when it rewraps taller', () => {
    // The edge sits 30% of the way into a 1000px paragraph; narrowing moves it to -280 and makes it 1400px tall.
    const point = anchorPoint(-300, 1000, 0)
    expect(point).toEqual({ fraction: 0.3, offset: 0 })
    // 30% of 1400 is 420, so the edge belongs 140px below the paragraph's new top: scroll down by 140.
    expect(anchoredScrollTop(5000, -280, 1400, 0, point)).toBe(5140)
  })

  it('keeps the same passage when the element rewraps shorter', () => {
    const point = anchorPoint(-600, 800, 0)
    expect(anchoredScrollTop(5000, -500, 400, 0, point)).toBe(4800)
  })

  it('holds a pixel gap above an element that starts below the edge', () => {
    // A 100px element 40px below the edge grows to 200px and moves to 90px: it should be 40px below again.
    const point = anchorPoint(40, 100, 0)
    expect(point).toEqual({ fraction: 0, offset: -40 })
    expect(anchoredScrollTop(5000, 90, 200, 0, point)).toBe(5050)
  })

  it('holds a pixel gap below an element that ends above the edge', () => {
    // A 100px element ending 100px above the edge grows to 150px: the edge stays 100px past its bottom.
    const point = anchorPoint(-200, 100, 0)
    expect(point).toEqual({ fraction: 1, offset: 100 })
    expect(anchoredScrollTop(5000, -300, 150, 0, point)).toBe(4950)
  })

  it('measures from a scroller that does not start at the top of the window', () => {
    const point = anchorPoint(-200 + 60, 1000, 60)
    expect(anchoredScrollTop(5000, -250 + 60, 2000, 60, point)).toBe(5000 - 250 + 400)
  })

  it('reads an empty element as a point at its top', () => {
    expect(anchorPoint(-10, 0, 0)).toEqual({ fraction: 0, offset: 10 })
  })
})
