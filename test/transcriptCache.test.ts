import { describe, expect, it } from 'vitest'
import {
  NO_TRANSCRIPT,
  TRANSCRIPT_CACHE_CAP,
  UNINDEXED_REVISION,
  cacheGet,
  cachePut,
  isCurrent,
  pendingState,
  shownState,
  transcriptRevision,
  type CachedTranscript,
  type TranscriptState
} from '../src/renderer/lib/transcriptCache'
import type { Transcript } from '../src/shared/types'

/**
 * The renderer's transcript cache: when a cached copy can stand in for a fetch, and which entry falls
 * off past the cap.
 */

const transcript = (sessionId: string): Transcript => ({ sessionId, agent: 'claude', messages: [] }) as unknown as Transcript
const entry = (id: string, revision = '1:1'): CachedTranscript => ({ transcript: transcript(id), revision })
const filled = (ids: string[], cap: number): Map<string, CachedTranscript> => {
  const cache = new Map<string, CachedTranscript>()
  for (const id of ids) cachePut(cache, id, entry(id), cap)
  return cache
}

describe('transcriptRevision', () => {
  it('changes with either the modification time or the size', () => {
    expect(transcriptRevision({ mtime: 100, sizeBytes: 5 })).toBe('100:5')
    expect(transcriptRevision({ mtime: 100, sizeBytes: 6 })).not.toBe(transcriptRevision({ mtime: 100, sizeBytes: 5 }))
    expect(transcriptRevision({ mtime: 101, sizeBytes: 5 })).not.toBe(transcriptRevision({ mtime: 100, sizeBytes: 5 }))
  })

  it('is the unindexed placeholder for a conversation the index has not listed', () => {
    expect(transcriptRevision(null)).toBe(UNINDEXED_REVISION)
    expect(transcriptRevision(undefined)).toBe(UNINDEXED_REVISION)
  })
})

describe('isCurrent', () => {
  it('stands in for a fetch at the revision it was fetched for', () => {
    expect(isCurrent(entry('a', '100:5'), '100:5')).toBe(true)
  })

  it('refetches once the revision moves on', () => {
    expect(isCurrent(entry('a', '100:5'), '100:6')).toBe(false)
  })

  it('refetches a conversation whose last fetch found nothing', () => {
    expect(isCurrent({ transcript: null, revision: '100:5' }, '100:5')).toBe(false)
  })

  it('refetches with nothing cached', () => {
    expect(isCurrent(undefined, '100:5')).toBe(false)
  })

  it('never trusts a match while the conversation is unindexed', () => {
    expect(isCurrent(entry('a', UNINDEXED_REVISION), UNINDEXED_REVISION)).toBe(false)
  })
})

describe('cacheGet', () => {
  it('returns nothing, and adds nothing, for an uncached conversation', () => {
    const cache = filled(['a'], 3)
    expect(cacheGet(cache, 'b')).toBeUndefined()
    expect([...cache.keys()]).toEqual(['a'])
  })

  it('marks the entry most recently used, so the least recently READ falls off — not the oldest written', () => {
    const cache = filled(['a', 'b', 'c'], 3)
    expect(cacheGet(cache, 'a')?.transcript?.sessionId).toBe('a')
    cachePut(cache, 'd', entry('d'), 3)
    expect([...cache.keys()]).toEqual(['c', 'a', 'd'])
  })
})

describe('cachePut', () => {
  it('replaces an existing entry and makes it the most recent, without evicting another', () => {
    const cache = filled(['a', 'b', 'c'], 3)
    cachePut(cache, 'a', entry('a', '2:2'), 3)
    expect([...cache.keys()]).toEqual(['b', 'c', 'a'])
    expect(cache.get('a')?.revision).toBe('2:2')
    cachePut(cache, 'd', entry('d'), 3)
    expect([...cache.keys()]).toEqual(['c', 'a', 'd'])
  })

  it('honors the cap it is given', () => {
    expect([...filled(['a', 'b', 'c', 'd'], 2).keys()]).toEqual(['c', 'd'])
  })

  it('trims back to the cap however far over it the cache is', () => {
    const cache = filled(['a', 'b', 'c', 'd', 'e'], 10)
    cachePut(cache, 'f', entry('f'), 2)
    expect([...cache.keys()]).toEqual(['e', 'f'])
  })

  it('defaults to the exported cap', () => {
    const cache = new Map<string, CachedTranscript>()
    const ids = Array.from({ length: TRANSCRIPT_CACHE_CAP + 1 }, (_, i) => `s${i}`)
    for (const id of ids) cachePut(cache, id, entry(id))
    expect([...cache.keys()]).toEqual(ids.slice(1))
  })
})

describe('pendingState', () => {
  const a = transcript('a')
  const b = transcript('b')
  const showingA: TranscriptState = { id: 'a', transcript: a, loading: false }

  it('shows the cached transcript at once', () => {
    expect(pendingState(NO_TRANSCRIPT, 'b', { transcript: b, revision: '1:1' })).toEqual({ id: 'b', transcript: b, loading: false })
  })

  it('loads a session with nothing cached — never the previous session, never an empty pane', () => {
    expect(pendingState(showingA, 'b', undefined)).toEqual({ id: 'b', transcript: null, loading: true })
  })

  it('treats a cached empty result as nothing cached', () => {
    expect(pendingState(NO_TRANSCRIPT, 'b', { transcript: null, revision: '1:1' })).toEqual({ id: 'b', transcript: null, loading: true })
  })

  it('keeps showing its own transcript when the cache has dropped it', () => {
    expect(pendingState(showingA, 'a', undefined)).toBe(showingA)
  })

  it('keeps the same state when the cache holds the transcript already showing', () => {
    expect(pendingState(showingA, 'a', { transcript: a, revision: '1:1' })).toBe(showingA)
  })

  it('moves to a newer cached transcript of the same session', () => {
    // Equal in content to the one showing, so only identity can tell them apart.
    const newer = transcript('a')
    const next = pendingState(showingA, 'a', { transcript: newer, revision: '2:2' })
    expect(next.transcript).toBe(newer)
    expect(next).toEqual({ id: 'a', transcript: newer, loading: false })
  })
})

describe('shownState', () => {
  const a = transcript('a')
  const b = transcript('b')
  const showingA: TranscriptState = { id: 'a', transcript: a, loading: false }

  it('shows nothing while the view is off or has no session', () => {
    expect(shownState(showingA, 'a', false, { transcript: a, revision: '1:1' })).toBe(NO_TRANSCRIPT)
    expect(shownState(showingA, null, true, undefined)).toBe(NO_TRANSCRIPT)
  })

  it('shows the state the fetch settled, empty result included', () => {
    const empty: TranscriptState = { id: 'a', transcript: null, loading: false }
    expect(shownState(empty, 'a', true, { transcript: a, revision: '1:1' })).toBe(empty)
  })

  it('answers a newly requested session from the cache in the same render', () => {
    expect(shownState(showingA, 'b', true, { transcript: b, revision: '1:1' })).toEqual({ id: 'b', transcript: b, loading: false })
  })

  it('shows a newly requested uncached session as loading, not as the previous one', () => {
    expect(shownState(showingA, 'b', true, undefined)).toEqual({ id: 'b', transcript: null, loading: true })
  })

  it('shows a re-enabled view as loading rather than empty', () => {
    expect(shownState(NO_TRANSCRIPT, 'a', true, undefined)).toEqual({ id: 'a', transcript: null, loading: true })
  })
})
