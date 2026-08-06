import { useCallback, useEffect, useState } from 'react'

/**
 * The "copy Formatted-view selections as Markdown" preference, persisted in localStorage.
 *
 * On (the default), ⌘C over a transcript selection puts the underlying markdown source on the clipboard
 * instead of the rendered plain text — the same thing the copy buttons give you, scoped to whatever is
 * highlighted. Off yields plain text.
 *
 * Off does NOT hand back to the browser's native copy: `TranscriptView.handleCopy` builds the plain text
 * itself, because `Range.toString()` ignores `user-select: none` and would drag a code block's language
 * caption in with it. The toggle changes the FORMAT, never which text you get.
 *
 * Owned once in App — both TranscriptView and the Preferences UI read it, and a second useState(load)
 * copy would desync from this one's writes. Mirrors useNewConvoDefault / useMaxLiveSessions.
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

export interface MarkdownCopy {
  enabled: boolean
  setEnabled: (value: boolean) => void
}

/** Persisted markdown-copy preference (default on). */
export function useMarkdownCopy(): MarkdownCopy {
  const [enabled, setEnabledState] = useState<boolean>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled }))
    } catch {
      /* storage unavailable */
    }
  }, [enabled])

  const setEnabled = useCallback((v: boolean) => setEnabledState(v), [])

  return { enabled, setEnabled }
}
