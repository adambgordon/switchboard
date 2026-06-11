/**
 * Pure theme core — types + the mode→theme resolution. No DOM access, so it typechecks under the
 * node project (the test suite imports `resolveTheme`) as well as the renderer. The browser-side
 * helpers that read/apply theme live in ./themeDom (renderer-only).
 */

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_KEY = 'switchboard.theme'

/** Resolve a mode to a concrete theme. 'system' follows the OS; explicit modes ignore it. */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light'
  return mode
}
