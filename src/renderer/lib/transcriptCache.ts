/**
 * The renderer's per-session transcript cache, behind the Formatted view's instant re-show.
 *
 * Each entry remembers the revision it was fetched for, so re-opening a conversation whose file the
 * index has not seen change skips the fetch — and the second full render a fresh object graph would
 * cost (it defeats every memoized block). A changed revision refetches as before, and so does a
 * conversation the index has not listed yet: with no revision to compare, a match proves nothing.
 *
 * Least-recently-used entries fall off past the cap, so browsing many conversations cannot grow
 * memory for the life of the window. A transcript on screen is held by its view regardless.
 */

import type { ConversationMeta, Transcript } from '../../shared/types'

export interface CachedTranscript {
  transcript: Transcript | null
  /** The revision the fetch was made for. */
  revision: string
}

export const TRANSCRIPT_CACHE_CAP = 12

/** The revision of a conversation the index has not listed yet. */
export const UNINDEXED_REVISION = 'unindexed'

/** A conversation's revision: changes whenever the index sees its file change. */
export function transcriptRevision(meta: Pick<ConversationMeta, 'mtime' | 'sizeBytes'> | null | undefined): string {
  return meta ? `${meta.mtime}:${meta.sizeBytes}` : UNINDEXED_REVISION
}

/** True when the entry can stand in for a fetch at `revision`. */
export function isCurrent(entry: CachedTranscript | undefined, revision: string): boolean {
  return entry !== undefined && entry.transcript !== null && revision !== UNINDEXED_REVISION && entry.revision === revision
}

/** What a Formatted view shows: its session's transcript, or that one is still on its way. */
export interface TranscriptState {
  id: string | null
  transcript: Transcript | null
  /** A fetch is outstanding and there is nothing to show meanwhile. */
  loading: boolean
}

export const NO_TRANSCRIPT: TranscriptState = { id: null, transcript: null, loading: false }

/**
 * What to show for `id` before its fetch answers: the cached transcript if there is one, else the one
 * already showing for it, else loading. Never "no transcript" — the pane reads a null transcript that
 * is not loading as an empty conversation, so only a fetch that came back empty may say so. A cached
 * empty result counts as nothing cached: it is about to be checked again. Returns `prev` itself when
 * that is already the answer, so a refresh of the showing transcript costs no render.
 */
export function pendingState(prev: TranscriptState, id: string, cached: CachedTranscript | undefined): TranscriptState {
  const showing = prev.id === id && prev.transcript !== null
  if (cached !== undefined && cached.transcript !== null) {
    return showing && prev.transcript === cached.transcript ? prev : { id, transcript: cached.transcript, loading: false }
  }
  if (showing) return prev
  return { id, transcript: null, loading: true }
}

/**
 * What to show this render. A newly requested session is answered from the cache during the render
 * itself, so the frame before the fetching effect runs shows the right transcript — not the previous
 * session's, and not an empty pane.
 */
export function shownState(
  state: TranscriptState,
  sessionId: string | null,
  enabled: boolean,
  cached: CachedTranscript | undefined
): TranscriptState {
  if (!sessionId || !enabled) return NO_TRANSCRIPT
  return state.id === sessionId ? state : pendingState(state, sessionId, cached)
}

/** The entry, marked most recently used. */
export function cacheGet(cache: Map<string, CachedTranscript>, id: string): CachedTranscript | undefined {
  const entry = cache.get(id)
  if (entry === undefined) return undefined
  cache.delete(id)
  cache.set(id, entry)
  return entry
}

/** Store the entry as most recently used, evicting the least recently used past `cap`. */
export function cachePut(
  cache: Map<string, CachedTranscript>,
  id: string,
  entry: CachedTranscript,
  cap: number = TRANSCRIPT_CACHE_CAP
): void {
  cache.delete(id)
  cache.set(id, entry)
  for (const oldest of cache.keys()) {
    if (cache.size <= cap) break
    cache.delete(oldest)
  }
}
