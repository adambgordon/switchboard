import { useCallback, useState } from 'react'
import { useStorageSync } from './useStorageSync'

/**
 * Shared, persisted format preference. Selection-copy decides which nested formatting survives;
 * whole-content actions preserve complete formatting. Both modes exclude renderer chrome.
 */
const KEY = 'switchboard.markdownCopy'

function load(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return true
    const o = JSON.parse(raw) as { enabled?: unknown }
    return typeof o.enabled === 'boolean' ? o.enabled : true
  } catch {
    return true
  }
}

function save(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled }))
  } catch {
    /* storage unavailable */
  }
}

export interface MarkdownCopy {
  enabled: boolean
  setEnabled: (value: boolean) => void
}

/** Persisted markdown-copy preference (default on). */
export function useMarkdownCopy(): MarkdownCopy {
  const [enabled, setEnabledState] = useState<boolean>(load)
  useStorageSync(KEY, load, setEnabledState)

  const setEnabled = useCallback((v: boolean) => {
    save(v)
    setEnabledState(v)
  }, [])

  return { enabled, setEnabled }
}
