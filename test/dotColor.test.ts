import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOT_COLOR,
  DOT_COLOR_COMMIT_MS,
  clampDotColor,
  contrastRatio,
  oklch,
  parseDotColor,
  shouldCommit
} from '../src/renderer/lib/dotColor'

/** Mirrors the reference surfaces the clamp is solved against. */
const SURFACE = { light: '#f4f4f4', dark: '#2a2a2a' } as const

/** Picks spanning the gamut corners, where a free-form color is most likely to disappear. */
const PICKS = [
  '#1f5ae6',
  '#ffff00',
  '#ffffff',
  '#000000',
  '#00ff00',
  '#ff0000',
  '#0000ff',
  '#808080',
  '#0a0a0a',
  '#fffbea'
]

describe('parseDotColor', () => {
  it('returns the fallback when nothing has been chosen', () => {
    expect(parseDotColor(null)).toBe(DEFAULT_DOT_COLOR)
    expect(parseDotColor('')).toBe(DEFAULT_DOT_COLOR)
  })

  it('honors a fallback that differs from the default', () => {
    // A fallback equal to DEFAULT_DOT_COLOR could not tell "returned the fallback" from
    // "returned the constant", so absence is pinned at a value the module never mentions.
    expect(parseDotColor(null, '#ff0000')).toBe('#ff0000')
    expect(parseDotColor('not a color', '#ff0000')).toBe('#ff0000')
  })

  it('accepts #rrggbb and normalizes case and padding', () => {
    expect(parseDotColor('#1F5AE6')).toBe('#1f5ae6')
    expect(parseDotColor('  #1f5ae6  ')).toBe('#1f5ae6')
  })

  it('rejects every near-miss form', () => {
    for (const raw of ['#abc', '#1f5ae', '#1f5ae6ff', '#GGGGGG', '1f5ae6', 'rgb(31,90,230)']) {
      expect(parseDotColor(raw, '#ff0000')).toBe('#ff0000')
    }
  })
})

describe('shouldCommit', () => {
  it('stores a pick that differs from what is stored', () => {
    expect(shouldCommit('#00a400', null)).toBe(true)
    expect(shouldCommit('#00a400', '#1f5ae6')).toBe(true)
  })

  it('does not resurrect a pick that was cancelled', () => {
    // Reset clears what is pending, but a timer armed before it still fires. If that fired write
    // went through it would land after the reset and silently undo it.
    expect(shouldCommit(null, '#00a400')).toBe(false)
    expect(shouldCommit(null, null)).toBe(false)
  })

  it('does not rewrite a value that is already stored', () => {
    // A redundant write wakes every other window through the storage event to tell them nothing
    // changed — which is the cost this coalescing exists to avoid in the first place.
    expect(shouldCommit('#00a400', '#00a400')).toBe(false)
  })

  it('waits long enough to coalesce a drag but still feel immediate', () => {
    // Pinned as a range rather than the literal: the point is the magnitude, and asserting the
    // constant against itself would prove nothing.
    expect(DOT_COLOR_COMMIT_MS).toBeGreaterThanOrEqual(120)
    expect(DOT_COLOR_COMMIT_MS).toBeLessThanOrEqual(500)
  })
})

describe('contrastRatio', () => {
  it('spans 1 to 21', () => {
    expect(contrastRatio('#808080', '#808080')).toBeCloseTo(1, 5)
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 4)
  })

  it('is symmetric', () => {
    expect(contrastRatio('#1f5ae6', '#f4f4f4')).toBeCloseTo(contrastRatio('#f4f4f4', '#1f5ae6'), 9)
  })

  it('uses the piecewise sRGB curve, not an approximate gamma', () => {
    // #0a0a0a sits below the transfer function's knee (0.04045 x 255 ~ 10.3), the one place the
    // piecewise curve and a plain ^2.2 disagree enough to see. A ^2.2 implementation returns
    // ~1.016 here and matches everywhere else, so this fixture is what localizes that mistake.
    expect(contrastRatio('#0a0a0a', '#000000')).toBeCloseTo(1.0607, 3)
  })
})

describe('clampDotColor', () => {
  it('leaves the shipped cobalt alone in both themes', () => {
    // The reference surfaces are chosen so today's dot clears the floor exactly as it does now.
    // If this fails, the floor has been set stricter than the design it is meant to preserve.
    expect(contrastRatio('#1f5ae6', SURFACE.light)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio('#3b6cf0', SURFACE.dark)).toBeGreaterThanOrEqual(3)
    expect(clampDotColor('#1f5ae6', 'light')).toBe('#1f5ae6')
    expect(clampDotColor('#3b6cf0', 'dark')).toBe('#3b6cf0')
  })

  it('returns an already-legible color byte-for-byte', () => {
    // A pick that clears the floor is the nearest legible lightness to itself, so the solve must
    // land back on it exactly — a derivation that "improves" a legible pick is wrong. Enough
    // colors to pin the property rather than a lucky few, since nothing short-circuits the search.
    for (const hex of ['#1f5ae6', '#ff0000', '#0000ff', '#000000', '#0a0a0a', '#8000ff']) {
      expect(clampDotColor(hex, 'light'), `${hex} light`).toBe(hex)
    }
    for (const hex of ['#ffff00', '#ffffff', '#00ff00', '#808080', '#3b6cf0', '#00ffff']) {
      expect(clampDotColor(hex, 'dark'), `${hex} dark`).toBe(hex)
    }
  })

  it('clears the contrast floor for every pick in both themes', () => {
    for (const pick of PICKS) {
      for (const theme of ['light', 'dark'] as const) {
        const shown = clampDotColor(pick, theme)
        expect(
          contrastRatio(shown, SURFACE[theme]),
          `${pick} in ${theme} rendered as ${shown}`
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('moves away from the surface, in the direction that theme requires', () => {
    // Asserted as two separate directions on purpose: a theme-blind implementation that always
    // darkened (or always lightened) would satisfy either one of these alone.
    const paleInLight = clampDotColor('#ffff00', 'light')
    expect(contrastRatio(paleInLight, '#000000')).toBeLessThan(contrastRatio('#ffff00', '#000000'))

    const darkInDark = clampDotColor('#000000', 'dark')
    expect(contrastRatio(darkInDark, '#ffffff')).toBeLessThan(contrastRatio('#000000', '#ffffff'))
  })

  it('keeps the chosen hue', () => {
    // A transposed row in either OKLab matrix still produces a plausible-looking color, but not one
    // whose dominant channel survives. Cheap, and it fails loudly on that mistake.
    const [r, g, b] = [
      clampDotColor('#ff0000', 'light'),
      clampDotColor('#00ff00', 'light'),
      clampDotColor('#0000ff', 'dark')
    ]
    const ch = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
    expect(ch(r, 0)).toBeGreaterThan(Math.max(ch(r, 1), ch(r, 2)))
    expect(ch(g, 1)).toBeGreaterThan(Math.max(ch(g, 0), ch(g, 2)))
    expect(ch(b, 2)).toBeGreaterThan(Math.max(ch(b, 0), ch(b, 1)))
  })

  it('holds hue when it has to leave the sRGB gamut', () => {
    // Moving a saturated color's lightness can ask for one sRGB cannot show. Shedding chroma keeps
    // the hue; clamping the channels instead keeps the chroma and bends the hue, which is a
    // different color from the one the user picked.
    //
    // Both behaviors still clear the contrast floor and still look plausible, so only hue
    // separates them — and only on inputs that actually leave the gamut. #8000ff in dark drifts
    // 0.2 degrees here against 5.0 when the channels are clamped; #0000ff, 0.07 against 1.7.
    const cases = [
      ['#8000ff', 'dark'],
      ['#0000ff', 'dark'],
      ['#00ffff', 'light'],
      ['#ff00ff', 'light']
    ] as const
    for (const [pick, theme] of cases) {
      const drift = Math.abs(oklch(clampDotColor(pick, theme)).h - oklch(pick).h) * (180 / Math.PI)
      expect(Math.min(drift, 360 - drift), `${pick} in ${theme}`).toBeLessThan(1)
    }
  })

  it('is idempotent', () => {
    for (const pick of PICKS) {
      for (const theme of ['light', 'dark'] as const) {
        const once = clampDotColor(pick, theme)
        expect(clampDotColor(once, theme)).toBe(once)
      }
    }
  })

  it('normalizes case without otherwise altering an in-band pick', () => {
    expect(clampDotColor('#1F5AE6', 'light')).toBe('#1f5ae6')
  })
})
