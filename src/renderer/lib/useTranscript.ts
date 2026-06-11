import { useEffect, useRef, useState } from 'react'
import type { Transcript } from '@shared/types'

/**
 * Fetch a conversation transcript for the formatted view.
 *
 * - Snappy: if we've seen this session, show the cached transcript INSTANTLY
 *   (no spinner) and refresh in the background; first-time loads show a spinner.
 * - Live: re-fetches whenever the file watcher re-indexes, so an active
 *   conversation streams into the formatted view as `claude` writes to disk.
 *   Background refreshes never flip the loading flag, so there's no flicker.
 */
export function useTranscript(
  sessionId: string | null,
  enabled: boolean
): { transcript: Transcript | null; loading: boolean } {
  const cache = useRef(new Map<string, Transcript | null>())
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!sessionId || !enabled) {
      setTranscript(null)
      setLoading(false)
      return
    }
    const id = sessionId
    let alive = true

    const load = (background: boolean): void => {
      if (!background) {
        const cached = cache.current.get(id)
        if (cached !== undefined) {
          setTranscript(cached)
          setLoading(false)
        } else {
          setTranscript(null)
          setLoading(true)
        }
      }
      window.api.getTranscript(id).then((t) => {
        if (!alive) return
        cache.current.set(id, t)
        setTranscript(t)
        setLoading(false)
      })
    }

    load(false)

    // Live update: the watcher re-indexes (debounced) whenever any session file
    // changes; refresh the open transcript in the background so a running
    // conversation appears as it's written.
    const off = window.api.onSessionsChanged(() => {
      if (alive) load(true)
    })

    return () => {
      alive = false
      off()
    }
  }, [sessionId, enabled])

  return { transcript, loading }
}
