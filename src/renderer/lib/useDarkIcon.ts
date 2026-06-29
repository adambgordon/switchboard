import { useCallback, useEffect, useState } from 'react'

/**
 * The "dark dock icon" preference — a manual on/off toggle, INDEPENDENT of the light/dark theme,
 * persisted in localStorage (renderer state; survives restarts). App pushes the value to the main
 * process (window.api.setDockIcon) on mount and on every change; main swaps the macOS dock icon.
 * Default off (the bundled light icon).
 */
const KEY = 'switchboard.darkIcon'

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

export interface DarkIcon {
  value: boolean
  set: (v: boolean) => void
}

export function useDarkIcon(): DarkIcon {
  const [value, setValue] = useState<boolean>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, String(value))
    } catch {
      /* storage unavailable — the choice just won't persist this run */
    }
  }, [value])

  const set = useCallback((v: boolean) => setValue(v), [])
  return { value, set }
}
