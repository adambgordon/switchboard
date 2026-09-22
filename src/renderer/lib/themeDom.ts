/**
 * Browser-side theme helpers: read the persisted mode, read the OS preference, and apply a
 * resolved theme to the document. Split from ./theme (the pure core) so the pure part stays
 * node-typecheckable for the test suite; everything here touches DOM/web globals and is
 * renderer-only. Used by main.tsx (pre-render bootstrap) and useTheme.
 */
import { DOT_COLOR_KEY, clampDotColor, parseDotColor } from './dotColor'
import { THEME_KEY, type ResolvedTheme, type ThemeMode } from './theme'

/** Read the persisted mode, tolerating an absent or garbage value (→ 'system'). */
export function readThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    return 'system'
  }
}

/** Whether the OS currently prefers a dark appearance (false when matchMedia is unavailable). */
export function systemPrefersDark(): boolean {
  return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Apply the resolved theme: set <html data-theme> (which switches the dark token scope in
 * tokens.css) and sync the Electron window's backgroundColor to the painted --paper, so a live
 * window resize fills exposed regions with the current theme's color instead of flashing the
 * other one. Reading the COMPUTED --paper keeps that in lockstep with tokens.css even if the
 * palette is retuned later — one source of truth, no duplicated hex in the main process.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.dataset.theme = resolved
  try {
    const paper = getComputedStyle(root).getPropertyValue('--paper').trim()
    if (paper) window.api?.setBackgroundColor(paper)
  } catch {
    /* getComputedStyle / window.api not ready — the bg sync is best-effort cosmetics */
  }
}

/** Read the persisted dot color, tolerating an absent or garbage value (→ no custom color). */
export function readDotColor(): string | null {
  try {
    return parseDotColor(localStorage.getItem(DOT_COLOR_KEY))
  } catch {
    return null
  }
}

/**
 * Apply a custom liveness-dot color, or clear back to the shipped one.
 *
 * Writes `--dot` inline on <html>, which outranks every selector-matched rule — and leaves
 * `--live` alone, which is what keeps every other cobalt mark where it is.
 *
 * Clearing REMOVES the property. `initial` would not work: on a custom property that makes it
 * guaranteed-invalid, so `var(--dot)` falls back to unset — a transparent dot — rather than to
 * the shipped cobalt.
 *
 * Takes the resolved theme because the color is placed relative to the surface the dot sits on,
 * so callers must re-apply on a theme flip as well as on a change of color.
 */
export function applyDotColor(color: string | null, resolved: ResolvedTheme): void {
  const root = document.documentElement
  if (!color) {
    root.style.removeProperty('--dot')
    return
  }
  root.style.setProperty('--dot', clampDotColor(color, resolved))
}
