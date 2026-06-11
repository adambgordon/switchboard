import { useCallback, useEffect, useState } from 'react'
import { THEME_KEY, resolveTheme, type ResolvedTheme, type ThemeMode } from './theme'
import { applyTheme, readThemeMode, systemPrefersDark } from './themeDom'

export interface Theme {
  /** The user's choice: 'system' (follow the OS), 'light', or 'dark'. */
  mode: ThemeMode
  /** The concrete theme actually applied (mode resolved against the OS preference). */
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  /**
   * Flip to the opposite of the current resolved theme as an EXPLICIT light/dark choice — the
   * title-bar quick toggle. Always lands on a concrete mode (never 'system'), so one click is a
   * decisive override even when currently following the OS.
   */
  toggle: () => void
}

/**
 * App theme, persisted in localStorage ('switchboard.theme' = system|light|dark; default system).
 * 'system' tracks the OS via matchMedia and flips live; explicit light/dark ignore it. The
 * resolved theme is applied to <html data-theme> (+ the window bg) once in main.tsx before first
 * paint (no flash) and re-applied here on every mode / OS change. Mirrors useNewConvoDefault /
 * useLayout — owned once in App.
 */
export function useTheme(): Theme {
  const [mode, setMode] = useState<ThemeMode>(readThemeMode)
  const [sysDark, setSysDark] = useState<boolean>(systemPrefersDark)

  // Track the OS preference so 'system' resolves live. Harmless for explicit modes (resolveTheme
  // ignores sysDark for them), so no need to gate the listener on mode.
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setSysDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved = resolveTheme(mode, sysDark)

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, mode)
    } catch {
      /* storage unavailable */
    }
  }, [mode])

  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  const toggle = useCallback(
    () => setMode(resolveTheme(mode, sysDark) === 'dark' ? 'light' : 'dark'),
    [mode, sysDark]
  )

  return { mode, resolved, setMode, toggle }
}
