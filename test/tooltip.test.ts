import { describe, expect, it } from 'vitest'
import {
  clampTipText,
  MAX_TIP,
  placeTip,
  visibleTipLength,
  type TipBox
} from '../src/renderer/lib/tooltip'

describe('clampTipText', () => {
  it('leaves a label at or under the limit exactly as it was', () => {
    expect(clampTipText('Copy code')).toBe('Copy code')
    const exact = 'x'.repeat(MAX_TIP)
    expect(clampTipText(exact)).toBe(exact)
  })

  it('cuts the MIDDLE, keeping both ends', () => {
    const url = `https://example.com/a/${'z'.repeat(400)}/tail.json`
    const out = clampTipText(url)
    expect(out.startsWith('https://example.com/a/')).toBe(true)
    expect(out.endsWith('/tail.json')).toBe(true)
    expect(out).toContain('…')
  })

  it('lands exactly on the limit, ellipsis included', () => {
    // Off by one here is the difference between honoring the cap and quietly exceeding it. Counted
    // VISIBLY: the word joiners fencing the ellipsis are invisible, so they must not eat the budget.
    expect(visibleTipLength(clampTipText('y'.repeat(1000)))).toBe(MAX_TIP)
    expect(visibleTipLength(clampTipText('y'.repeat(1000), 41))).toBe(41)
    // Odd budgets can't split evenly; the head takes the extra character.
    expect(clampTipText('abcdefghij', 6)).toBe('abc⁠…⁠ij')
  })

  it('fences the ellipsis with word joiners so the line cannot break there', () => {
    // The `…` is the only standard break opportunity in a base64 URL, so without these the breaker
    // prefers it and strands the tail on a short line of its own.
    const out = clampTipText('z'.repeat(400))
    expect(out).toContain('⁠…⁠')
    // One on each side, and nowhere else.
    expect(Array.from(out).filter((c) => c === '⁠')).toHaveLength(2)
  })

  it('adds no joiners when nothing was truncated', () => {
    expect(clampTipText('Copy code')).not.toContain('⁠')
    expect(clampTipText('abcdef', 1)).not.toContain('⁠')
  })

  it('never splits a surrogate pair', () => {
    // Emoji are 2 UTF-16 units each, so a UTF-16 slice lands mid-pair and emits a lone surrogate that
    // renders as a replacement glyph. A conversation title can be all emoji, so this is reachable.
    //
    // THE BUDGET'S PARITY DECIDES WHETHER THIS TEST CAN FAIL AT ALL. A UTF-16 implementation only
    // splits a pair when a slice length is ODD, so `max` has to be chosen to produce one: 22 gives
    // head = ceil(21/2) = 11, which cuts the 6th emoji in half. An earlier version of this test used
    // 21 — head and tail both 10, both even — and passed against a deliberately broken `split('')`
    // implementation. It was asserting nothing.
    for (const max of [22, 23, 41]) {
      const out = clampTipText('🎉'.repeat(400), max)
      // A HIGH surrogate not followed by a low one, and a LOW one not preceded by a high one. The
      // class must be \uD800-\uDBFF, not \uD800-\uDFFF — the wider range spans both halves, so it
      // matches the low half of every well-formed pair and the assertion could never pass.
      expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
      expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      expect(Array.from(out).every((c) => c === '🎉' || c === '…' || c === '⁠')).toBe(true)
    }
  })

  it('degenerates to a bare ellipsis rather than doing arithmetic on a budget of 1', () => {
    expect(clampTipText('abcdef', 1)).toBe('…')
    expect(clampTipText('abcdef', 0)).toBe('…')
  })
})

describe('placeTip', () => {
  /** A 900px viewport with a one-line host at y 100–120, and a label of the given height. */
  const box = (height: number, over: Partial<TipBox> = {}): TipBox => ({
    hostTop: 100,
    hostBottom: 120,
    height,
    viewport: 900,
    gap: 7,
    edge: 8,
    ...over
  })

  it('takes BELOW when the label fits there', () => {
    expect(placeTip(box(22))).toEqual({ side: 'bottom', top: 127 })
  })

  it('flips ABOVE when the label is too tall to fit below', () => {
    // The case the old 60px probe got wrong: plenty of room by its test, nowhere near enough in fact.
    const p = placeTip(box(300, { hostTop: 700, hostBottom: 720 }))
    expect(p.side).toBe('top')
    // `top` is in the -100% transform's frame, so it is the host's edge minus the gap.
    expect(p.top).toBe(693)
  })

  it('decides on the MEASURED height, not on the host position alone', () => {
    // Same host, two label heights, two sides — which is the whole point of measuring first.
    const host = { hostTop: 700, hostBottom: 720 }
    expect(placeTip(box(22, host)).side).toBe('bottom')
    expect(placeTip(box(300, host)).side).toBe('top')
  })

  it('clamps into view when neither side has room, taking the roomier one', () => {
    const p = placeTip(box(500, { hostTop: 400, hostBottom: 420 }))
    // Room below 473, above 385 — so below, then clamped up to the last position that fits.
    expect(p.side).toBe('bottom')
    expect(p.top).toBe(900 - 8 - 500)
    expect(p.top + 500).toBeLessThanOrEqual(900 - 8)
  })

  it('pins a label taller than the viewport to the top edge', () => {
    // Unplaceable, so the only choice is WHICH end gets lost; keeping the start readable is the one
    // that leaves a URL's origin visible.
    const p = placeTip(box(1200, { hostTop: 400, hostBottom: 420 }))
    expect(p.side).toBe('bottom')
    expect(p.top).toBe(8)
  })

  it('respects the edge margin at the top when flipping above near the ceiling', () => {
    const p = placeTip(box(200, { hostTop: 40, hostBottom: 60, viewport: 260 }))
    const visualTop = p.side === 'bottom' ? p.top : p.top - 200
    expect(visualTop).toBeGreaterThanOrEqual(8)
  })
})
