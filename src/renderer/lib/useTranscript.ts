import { useEffect, useRef, useState } from 'react'
import type { Transcript } from '@shared/types'
import {
  NO_TRANSCRIPT,
  cacheGet,
  cachePut,
  isCurrent,
  pendingState,
  shownState,
  type CachedTranscript,
  type TranscriptState
} from './transcriptCache'

/**
 * Fetch a conversation transcript for the formatted view.
 *
 * - Snappy: if we've seen this session, show the cached transcript INSTANTLY
 *   (no spinner) and refresh in the background; first-time loads show a spinner.
 *   A cached copy already at the current revision needs no refresh at all. Both are
 *   decided during the render that asks for the session, not in the effect after it,
 *   so no frame shows the previous session or an empty pane — see transcriptCache.
 * - Live: re-fetches whenever the file watcher re-indexes, so an active
 *   conversation streams into the formatted view as `claude` writes to disk.
 *   Background refreshes never flip the loading flag, so there's no flicker.
 */
export function useTranscript(
  sessionId: string | null,
  revision: string,
  enabled: boolean,
  sharedCache?: Map<string, CachedTranscript>
): { transcript: Transcript | null; loading: boolean } {
  const localCache = useRef(new Map<string, CachedTranscript>())
  const cache = sharedCache ?? localCache.current
  const [state, setState] = useState<TranscriptState>(NO_TRANSCRIPT)

  useEffect(() => {
    if (!sessionId || !enabled) {
      setState(NO_TRANSCRIPT)
      return
    }
    const id = sessionId
    let alive = true

    const cached = cacheGet(cache, id)
    setState((prev) => pendingState(prev, id, cached))
    if (!isCurrent(cached, revision)) {
      window.api.getTranscript(id, revision).then((t) => {
        if (!alive) return
        cachePut(cache, id, { transcript: t, revision })
        setState({ id, transcript: t, loading: false })
      })
    }

    return () => {
      alive = false
    }
  }, [sessionId, revision, enabled, cache])

  const shown = shownState(state, sessionId, enabled, sessionId ? cache.get(sessionId) : undefined)
  return { transcript: shown.transcript, loading: shown.loading }
}
