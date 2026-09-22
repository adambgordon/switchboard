import { useCallback, useState } from 'react'
import { DEFAULT_DOT_COLOR, DOT_COLOR_KEY } from './dotColor'
import { readDotColor } from './themeDom'
import { useStorageSync } from './useStorageSync'

/**
 * The liveness dot's color, persisted in localStorage. Unset by default.
 *
 * Unset is not a color — it is the absence of a choice, which leaves `--dot` following the shipped
 * `--live`. That is what makes clearing the preference exact rather than a re-derivation that
 * happens to land on the same value.
 *
 * Stored as a bare `#rrggbb` string, like the theme mode, rather than wrapped in an object: there
 * is one value and no second field to grow into.
 *
 * Owned once per window in App, like the other preference hooks. Open windows synchronize through
 * the storage event so they cannot end up showing different dots.
 */
export interface DotColor {
  /** The chosen color, or null when none has been chosen. */
  color: string | null
  /** Persist a choice; null clears it and restores the shipped dot. */
  setColor: (hex: string | null) => void
}

export function useDotColor(): DotColor {
  const [color, setColorState] = useState<string | null>(readDotColor)

  // Another window's change arrives here, NOT through `setColor` — so it updates this copy
  // without writing, which is right: the window that made the change already stored it.
  useStorageSync(DOT_COLOR_KEY, readDotColor, setColorState)

  // The store is written HERE and nowhere else. Writing from an effect keyed on `color` would
  // also fire on mount, stamping a value into every profile that merely opened the app — which
  // erases the difference between "never chose" and "chose this", and would strand any later
  // change to the shipped color.
  const setColor = useCallback((hex: string | null) => {
    setColorState(hex ?? DEFAULT_DOT_COLOR)
    try {
      if (hex) localStorage.setItem(DOT_COLOR_KEY, hex)
      else localStorage.removeItem(DOT_COLOR_KEY)
    } catch {
      /* storage unavailable */
    }
  }, [])

  return { color, setColor }
}
