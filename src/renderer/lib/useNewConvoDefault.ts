import { useCallback, useEffect, useState } from 'react'

/**
 * The "default folder for new conversations" preference, persisted in localStorage (renderer state;
 * survives restarts). A chosen folder is always active: when `dir` is set, the "+" / ⌘N spawn straight
 * into it (skipping the folder chooser); '' means none chosen, so the chooser opens as usual.
 *
 * Owned once in App — both the +/⌘N handlers and the Preferences UI read it, and a second
 * useState(load) copy would desync from this one's writes. Mirrors useLayout/usePins.
 */
const KEY = 'switchboard.newConvoDefault'

function load(): string {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return ''
    const o = JSON.parse(raw) as { dir?: unknown }
    return typeof o.dir === 'string' ? o.dir : ''
  } catch {
    return ''
  }
}

export interface NewConvoDefault {
  dir: string
  setDir: (dir: string) => void
}

/** Persisted default-folder preference for new conversations (absolute path, '' = none). */
export function useNewConvoDefault(): NewConvoDefault {
  const [dir, setDirState] = useState<string>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ dir }))
    } catch {
      /* storage unavailable */
    }
  }, [dir])

  const setDir = useCallback((d: string) => setDirState(d), [])

  return { dir, setDir }
}
