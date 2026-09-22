import type { ResolvedTheme } from './theme'

/**
 * The liveness dot's color: the value behind `--dot`, which defaults to the shipped `--live`.
 *
 * Scoped to the dot alone. Every other cobalt mark — a live card's ring, the Live tally, Resume,
 * the brand marks — stays on `--live`, so this changes one signal rather than the palette.
 *
 * Pure and DOM-free so the test suite can import it under the node tsconfig — no `window`, and no
 * `localStorage` either (which `@types/node` declares, so it would compile and still belong in the
 * hook). The browser half lives in `themeDom.ts`, the same split as `theme.ts`.
 */

export const DOT_COLOR_KEY = 'switchboard.dotColor'

/**
 * Absent means "never chosen", and a never-chosen color is NOT a hex — it is the absence of one.
 * Nothing is written to the document in that state, so `--dot` keeps following `--live` and a
 * reset is exact rather than a re-derivation that happens to land on the same value.
 */
export const DEFAULT_DOT_COLOR: string | null = null

/** Shown in the picker when nothing is set. Presentation only — never persisted as a choice. */
export const DOT_COLOR_PLACEHOLDER = '#1f5ae6'

/**
 * How long the picker waits, after the last change, before storing.
 *
 * The OS color panel emits a change per pointer tick and has no OK button, so there is no moment
 * of "done" to listen for — storing each tick would write to disk and wake every other window on
 * every wiggle. Long enough to coalesce a drag, short enough to feel immediate on release.
 */
export const DOT_COLOR_COMMIT_MS = 250

/**
 * Whether a coalesced pick should still be stored when its wait elapses, or when the picker is
 * left before it does.
 *
 * Two things this rules out. A pick cancelled in the meantime — Reset clears what is pending, and
 * a timer armed before that must not resurrect it. And a pick equal to what is already stored,
 * which would wake every other window to tell them nothing changed.
 */
export function shouldCommit(pending: string | null, stored: string | null): boolean {
  return pending !== null && pending !== stored
}

/**
 * Surfaces the dot is held to: the rail's flat rows in light, a live card in dark. Each is the
 * least favorable of the resting surfaces the dot sits on in that theme, since a dark-on-light dot
 * is worst on the darker surface and a light-on-dark dot on the lighter one. Both are calibrated
 * so the shipped cobalt clears the floor exactly as it does today.
 *
 * Literals rather than a computed read: the solve runs on every picker event, and asking for a
 * computed style there would force a layout recalc on a drag. They therefore MUST be updated by
 * hand when `--paper-sunken` or `--paper-raised` move, the same standing obligation `TerminalView`
 * carries for the surfaces it hands xterm.
 */
const REFERENCE_SURFACE: Record<ResolvedTheme, string> = { light: '#f4f4f4', dark: '#2a2a2a' }

/** WCAG 1.4.11 non-text contrast. The dot is a signal, never prose. */
const MIN_CONTRAST = 3

const HEX = /^#[0-9a-f]{6}$/i

/**
 * Read a stored color, falling back for anything that is not an explicit `#rrggbb` choice.
 *
 * `fallback` is a parameter rather than a closed-over constant so a test can pin the rule at a
 * value that differs from the default — otherwise "returned the fallback" and "returned the
 * constant" are indistinguishable. Same reason as `parseTabsEnabled`.
 */
export function parseDotColor(
  raw: string | null,
  fallback: string | null = DEFAULT_DOT_COLOR
): string | null {
  if (!raw) return fallback
  const trimmed = raw.trim()
  return HEX.test(trimmed) ? trimmed.toLowerCase() : fallback
}

// ---- sRGB <-> OKLab -------------------------------------------------------------------------
// Ottosson's OKLab. Perceptual lightness is what makes the contrast solve below converge the same
// way for every hue; sRGB and HSL lightness do not, so a fixed "lighten for dark" step would
// overshoot warm hues and undershoot cool ones.

/** sRGB 0-1 to linear-light. The piecewise curve, not an approximate gamma — they differ near 0. */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function toGamma(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

type Rgb = { r: number; g: number; b: number }
type Lab = { L: number; a: number; b: number }
type Lch = { L: number; C: number; h: number }

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (c: number): string =>
    Math.round(Math.min(1, Math.max(0, c)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function rgbToLab({ r, g, b }: Rgb): Lab {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  }
}

function labToRgb({ L, a, b }: Lab): Rgb {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
  return {
    r: toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  }
}

function lchToLab({ L, C, h }: Lch): Lab {
  return { L, a: C * Math.cos(h), b: C * Math.sin(h) }
}

/**
 * Perceptual lightness, chroma and hue — the terms this module reasons in. Exposed because hue
 * fidelity through the clamp is a property worth asserting, and it cannot be read off a hex.
 */
export function oklch(hex: string): Lch {
  const { L, a, b } = rgbToLab(hexToRgb(hex))
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) }
}

function inGamut({ r, g, b }: Rgb): boolean {
  const ok = (c: number): boolean => c >= -1e-4 && c <= 1 + 1e-4
  return ok(r) && ok(g) && ok(b)
}

/**
 * Render an OKLCH triple as sRGB, shedding chroma until it fits the gamut. Reducing chroma holds
 * the hue; clamping channels does not, so a saturated out-of-gamut color would drift hue instead of
 * desaturating.
 */
function renderInGamut(lch: Lch): string {
  if (inGamut(labToRgb(lchToLab(lch)))) return rgbToHex(labToRgb(lchToLab(lch)))
  let lo = 0
  let hi = lch.C
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(labToRgb(lchToLab({ ...lch, C: mid })))) lo = mid
    else hi = mid
  }
  return rgbToHex(labToRgb(lchToLab({ ...lch, C: lo })))
}

// ---- contrast -------------------------------------------------------------------------------

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** WCAG contrast ratio, 1-21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/**
 * Place a chosen color where the dot can still be seen, keeping its hue and as much chroma as the
 * gamut allows.
 *
 * A free-form pick can land anywhere, including colors that erase the dot: pure yellow against the
 * light rail is about 1.03:1, and a 7px disc at that contrast is not a signal. The hollow states
 * are thinner still — a 1.5px ring — so the floor protects the weakest form, not the solid one.
 *
 * The result is the lightness NEAREST the chosen one that clears `MIN_CONTRAST` — which for a pick
 * that already clears it is that pick, unchanged. One rule covers both cases, so there is no
 * separate in-band branch to keep in step with the search. Written as a solve against the contrast
 * requirement rather than a fixed lightness window, so the requirement is the code itself.
 */
export function clampDotColor(hex: string, theme: ResolvedTheme): string {
  const surface = REFERENCE_SURFACE[theme]
  const lch = oklch(hex)
  // Light surfaces need a darker dot, dark surfaces a lighter one.
  const target = theme === 'light' ? 0 : 1
  let lo = lch.L
  let hi = target
  let best = renderInGamut({ ...lch, L: target })

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const candidate = renderInGamut({ ...lch, L: mid })
    if (contrastRatio(candidate, surface) >= MIN_CONTRAST) {
      best = candidate
      hi = mid
    } else {
      lo = mid
    }
  }
  return best
}
