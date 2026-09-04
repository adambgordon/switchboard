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
  revision: string,
  enabled: boolean,
  sharedCache?: Map<string, Transcript | null>
): { transcript: Transcript | null; loading: boolean } {
  const localCache = useRef(new Map<string, Transcript | null>())
  const cache = sharedCache ?? localCache.current
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

    const load = (): void => {
      const cached = cache.get(id)
      if (cached !== undefined) {
        setTranscript(cached)
        setLoading(false)
      } else {
        setTranscript(null)
        setLoading(true)
      }
      window.api.getTranscript(id, revision).then((t) => {
        if (!alive) return
        cache.set(id, t)
        setTranscript(t)
        setLoading(false)
      })
    }

    load()

    return () => {
      alive = false
    }
  }, [sessionId, revision, enabled, cache])

  return { transcript, loading }
}
