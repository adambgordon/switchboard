import { useCallback, useRef, useState } from 'react'
import { CONFIG } from '@shared/types'
import { useStorageSync } from './useStorageSync'

/**
 * The "maximum live sessions" preference — the LRU cap on concurrent live PTYs. Persisted in
 * localStorage (renderer state; survives restarts) and pushed to the main-process PtyManager by App
 * via window.api.setMaxLiveSessions. Defaults to CONFIG.maxLivePtys and is clamped to the shared
 * [liveSessionsMin, liveSessionsMax] bounds — the ceiling tracks Chromium's WebGL-context limit,
 * past which live terminals fall back to the canvas renderer.
 *
 * Owned once in App (mirrors useNewConvoDefault / useLayout): both the slider handler and the IPC
 * push read this one copy, so a second useState(load) elsewhere can't desync from its writes.
 */
const KEY = 'switchboard.maxLiveSessions'

function clamp(n: number): number {
  if (!Number.isFinite(n)) return CONFIG.maxLivePtys
  return Math.max(CONFIG.liveSessionsMin, Math.min(CONFIG.liveSessionsMax, Math.floor(n)))
}

function load(): number {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw == null) return CONFIG.maxLivePtys
    return clamp(parseInt(raw, 10))
  } catch {
    return CONFIG.maxLivePtys
  }
}

function save(value: number): void {
  try {
    localStorage.setItem(KEY, String(value))
  } catch {
    /* storage unavailable */
  }
}

export interface MaxLiveSessions {
  /** Current cap. */
  value: number
  /** Inclusive bounds (the slider's min / max). */
  min: number
  max: number
  /** The default the Reset control restores to (CONFIG.maxLivePtys). */
  defaultValue: number
  /** Set the cap to an explicit value (clamped) — the slider's onChange. */
  set: (n: number) => void
  reset: () => void
}

/** Persisted, clamped max-live-sessions preference (the LRU cap). */
export function useMaxLiveSessions(): MaxLiveSessions {
  const [value, setValue] = useState<number>(load)
  const valueRef = useRef(value)
  valueRef.current = value
  useStorageSync(KEY, load, setValue)

  const commit = useCallback((next: number) => {
    if (valueRef.current === next) return
    valueRef.current = next
    save(next)
    setValue(next)
  }, [])

  // The ref bails before both storage and state, so a slider drag writes only when it crosses an
  // integer step rather than on every pixel event within that step.
  const set = useCallback((n: number) => commit(clamp(n)), [commit])
  const reset = useCallback(() => commit(CONFIG.maxLivePtys), [commit])

  return {
    value,
    min: CONFIG.liveSessionsMin,
    max: CONFIG.liveSessionsMax,
    defaultValue: CONFIG.maxLivePtys,
    set,
    reset
  }
}
