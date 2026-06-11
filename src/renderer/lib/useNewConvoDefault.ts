import { useCallback, useEffect, useState } from 'react'

/**
 * The "default folder for new conversations" preference, persisted in localStorage (renderer
 * state; survives restarts). Two independent fields, on purpose: the user can turn the behavior
 * off without losing the path, so flipping it back on later is one click.
 *   - `dir`     — absolute path a new conversation should start in ('' = none chosen).
 *   - `enabled` — when true AND `dir` is set, the "+" / ⌘N spawn straight into `dir`, skipping the
 *                 folder chooser; when false the path is remembered but the chooser opens as usual.
 *
 * Owned once in App — both the +/⌘N handlers and the Preferences UI read it, and a second
 * useState(load) copy would desync from this one's writes. Mirrors useLayout/usePins.
 */
interface NewConvoDefaultState {
  dir: string
  enabled: boolean
}

const KEY = 'switchboard.newConvoDefault'
const DEFAULTS: NewConvoDefaultState = { dir: '', enabled: false }

function load(): NewConvoDefaultState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const o = JSON.parse(raw) as Partial<NewConvoDefaultState>
    return {
      dir: typeof o.dir === 'string' ? o.dir : DEFAULTS.dir,
      enabled: o.enabled === true
    }
  } catch {
    return DEFAULTS
  }
}

export interface NewConvoDefault extends NewConvoDefaultState {
  setDir: (dir: string) => void
  setEnabled: (enabled: boolean) => void
}

/** Persisted default-folder preference for new conversations (path + enabled toggle). */
export function useNewConvoDefault(): NewConvoDefault {
  const [state, setState] = useState<NewConvoDefaultState>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable */
    }
  }, [state])

  const setDir = useCallback((dir: string) => setState((s) => ({ ...s, dir })), [])
  const setEnabled = useCallback((enabled: boolean) => setState((s) => ({ ...s, enabled })), [])

  return { ...state, setDir, setEnabled }
}
