import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_CACHE_CAP,
  UNINDEXED_REVISION,
  cacheGet,
  cachePut,
  isCurrent,
  transcriptRevision,
  type CachedTranscript
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
