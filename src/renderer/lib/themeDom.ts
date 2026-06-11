/**
 * Browser-side theme helpers: read the persisted mode, read the OS preference, and apply a
 * resolved theme to the document. Split from ./theme (the pure core) so the pure part stays
 * node-typecheckable for the test suite; everything here touches DOM/web globals and is
 * renderer-only. Used by main.tsx (pre-render bootstrap) and useTheme.
 */
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
