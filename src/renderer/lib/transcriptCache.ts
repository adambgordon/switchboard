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
