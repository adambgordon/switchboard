import { describe, expect, it } from 'vitest'
import {
  clampTipText,
  endClampTip,
  MAX_TIP,
  placeTip,
  placeTipRight,
  tipBoxLeft,
  tipMetaLine,
  tipMorph,
  tipOnEnter,
  tipOnLeave,
  visibleTipLength,
  type TipBox,
  type TipRect
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
    // head = ceil(21/2) = 11, which cuts the 6th emoji in half. A budget of 21 gives head and tail
    // 10 each, both even, and passes against a UTF-16 `split('')` implementation, so it would
    // assert nothing.
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
    // A fixed-height probe misjudges this: it sees plenty of room, and there is nowhere near enough.
    const p = placeTip(box(300, { hostTop: 700, hostBottom: 720 }))
    expect(p.side).toBe('top')
    // The label's own top edge: the host's top, less the gap, less the label.
    expect(p.top).toBe(700 - 7 - 300)
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
    expect(p.top).toBeGreaterThanOrEqual(8)
  })
})

describe('tipBoxLeft', () => {
  it('centers the label on the host', () => {
    expect(tipBoxLeft(500, 120, 1200, 8)).toBe(440)
  })

  it('shifts right just enough to clear the left edge', () => {
    expect(tipBoxLeft(30, 120, 1200, 8)).toBe(8)
  })

  it('shifts left just enough to clear the right edge', () => {
    expect(tipBoxLeft(1180, 120, 1200, 8)).toBe(1200 - 8 - 120)
  })

  it('keeps the left edge when the label is wider than the viewport', () => {
    expect(tipBoxLeft(150, 400, 300, 8)).toBe(8)
  })
})

describe('tipMorph', () => {
  const to: TipRect = { left: 300, top: 200, width: 180, height: 40 }

  it('starts from the previous box: offset from the final one, at the previous size', () => {
    // Every field differs, in both directions, so a swapped axis or a reversed offset is caught.
    const from: TipRect = { left: 340, top: 150, width: 120, height: 64 }
    expect(tipMorph(from, to, false)).toEqual({ dx: 40, dy: -50, width: 120, height: 64 })
  })

  it('morphs a change of size alone, with no move', () => {
    expect(tipMorph({ ...to, width: 210 }, to, false)).toEqual({ dx: 0, dy: 0, width: 210, height: 40 })
    expect(tipMorph({ ...to, height: 25 }, to, false)).toEqual({ dx: 0, dy: 0, width: 180, height: 25 })
  })

  it('does not morph a label shown fresh, with nothing to start from', () => {
    expect(tipMorph(null, to, false)).toBeNull()
  })

  it('does not morph with motion turned off', () => {
    expect(tipMorph({ left: 340, top: 150, width: 120, height: 64 }, to, true)).toBeNull()
  })

  it('does not morph a change too small to see', () => {
    expect(tipMorph({ left: 300.3, top: 199.6, width: 180.4, height: 40.2 }, to, false)).toBeNull()
  })

  it('morphs once any one field moves by half a pixel', () => {
    expect(tipMorph({ ...to, left: 300.5 }, to, false)).not.toBeNull()
    expect(tipMorph({ ...to, top: 199.5 }, to, false)).not.toBeNull()
    expect(tipMorph({ ...to, width: 180.5 }, to, false)).not.toBeNull()
    expect(tipMorph({ ...to, height: 39.5 }, to, false)).not.toBeNull()
  })
})

describe('endClampTip', () => {
  it('leaves text at or under the budget exactly as it was', () => {
    expect(endClampTip('abcde', 5)).toBe('abcde')
    expect(endClampTip('abc', 5)).toBe('abc')
  })

  it('cuts the END, landing exactly on the budget with the ellipsis', () => {
    expect(endClampTip('abcdefghij', 6)).toBe('abcde…')
  })

  it('never splits a surrogate pair', () => {
    // Each emoji is two UTF-16 units; a budget of 4 keeps three code points. A UTF-16 slice would
    // keep one and a half emoji — a lone surrogate — and this would not equal the expected string.
    expect(endClampTip('😀😀😀😀😀', 4)).toBe('😀😀😀…')
    expect(endClampTip('a😀😀😀😀', 3)).toBe('a😀…')
  })

  it('degrades to a bare ellipsis at a budget too small for text', () => {
    expect(endClampTip('abc', 1)).toBe('…')
    expect(endClampTip('abc', 0)).toBe('…')
  })
})

describe('tipMetaLine', () => {
  const NOW = 1_800_000_000_000

  it('ages the timestamp against the time it is SHOWN, not a fixed clock', () => {
    expect(tipMetaLine(NOW - 3 * 3600_000, null, NOW)).toBe('3h ago')
    // The same timestamp, shown two days later.
    expect(tipMetaLine(NOW - 3 * 3600_000, null, NOW + 2 * 86400_000)).toBe('2d ago')
  })

  it('says "Just now" rather than "now ago"', () => {
    expect(tipMetaLine(NOW - 5_000, null, NOW)).toBe('Just now')
  })

  it('joins the age and the host\'s own line with a middot', () => {
    expect(tipMetaLine(NOW - 4 * 60_000, 'app · fix-scroll', NOW)).toBe('4m ago · app · fix-scroll')
  })

  it('omits whichever half is missing, and is null with neither', () => {
    expect(tipMetaLine(null, 'app', NOW)).toBe('app')
    expect(tipMetaLine(NOW, '', NOW)).toBe('Just now')
    expect(tipMetaLine(null, null, NOW)).toBeNull()
    expect(tipMetaLine(null, '', NOW)).toBeNull()
  })
})

describe('placeTipRight', () => {
  const base = {
    hostTop: 200,
    hostBottom: 230,
    hostRight: 300,
    width: 250,
    height: 70,
    viewportWidth: 1200,
    viewportHeight: 800,
    gap: 7,
    edge: 8
  }

  it('sits beside the host, centered on it', () => {
    // Center 215, so the top of a 70px label is 180.
    expect(placeTipRight(base)).toEqual({ left: 307, top: 180 })
  })

  it('clamps at the top and bottom edges instead of leaving the viewport', () => {
    expect(placeTipRight({ ...base, hostTop: 0, hostBottom: 30 }).top).toBe(8)
    expect(placeTipRight({ ...base, hostTop: 780, hostBottom: 800 }).top).toBe(800 - 8 - 70)
  })

  it('pins a label taller than the viewport to the top edge', () => {
    expect(placeTipRight({ ...base, height: 2000 }).top).toBe(8)
  })

  it('pulls left rather than running off the right edge', () => {
    expect(placeTipRight({ ...base, viewportWidth: 500 }).left).toBe(500 - 8 - 250)
  })
})

describe('tooltip groups', () => {
  // Groups compare by identity: two distinct containers, as the rail's rows and a toolbar are.
  const ROWS = { name: 'rows' }
  const TOOLBAR = { name: 'toolbar' }

  it('keeps a grouped label up moving onto another host in its group', () => {
    expect(tipOnLeave(ROWS, { group: ROWS }, true)).toBe('keep')
  })

  it('holds it through a gap inside its group, like a folder header between two rows', () => {
    expect(tipOnLeave(ROWS, null, true)).toBe('hold')
  })

  it('gives it only the short grace once the pointer has left the group onto nothing', () => {
    expect(tipOnLeave(ROWS, null, false)).toBe('grace')
  })

  it('hides it moving onto a host in another group, or in none, whose own label takes its delay', () => {
    // Even when that host sits inside the group's container, as a folder's new-conversation buttons sit
    // inside the rail: being inside the container only matters for a gap.
    for (const inGroup of [true, false]) {
      expect(tipOnLeave(ROWS, { group: TOOLBAR }, inGroup)).toBe('hide')
      expect(tipOnLeave(ROWS, { group: null }, inGroup)).toBe('hide')
    }
  })

  it('hides immediately when no grouped label is on screen, whatever comes next', () => {
    // A label still waiting out its delay has nothing to hold: leaving cancels it.
    for (const inGroup of [true, false]) {
      for (const to of [null, { group: null }, { group: ROWS }]) expect(tipOnLeave(null, to, inGroup)).toBe('hide')
    }
  })

  it('re-fills a grouped label at once on another host in its group', () => {
    expect(tipOnEnter(ROWS, { group: ROWS })).toBe('refill')
    expect(tipOnEnter(TOOLBAR, { group: TOOLBAR })).toBe('refill')
  })

  it('dismisses a grouped label still in its grace when the pointer reaches a host outside its group', () => {
    // Row, gap, toolbar button: the row's label must not stay up through the button's delay.
    expect(tipOnEnter(ROWS, { group: TOOLBAR })).toBe('replace')
    expect(tipOnEnter(ROWS, { group: null })).toBe('replace')
  })

  it('waits out the delay when no grouped label is on screen — a host in no group included', () => {
    // No label and no group are both null; that must never read as "the same group".
    expect(tipOnEnter(null, { group: null })).toBe('arm')
    expect(tipOnEnter(null, { group: ROWS })).toBe('arm')
  })
})
