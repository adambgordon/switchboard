import { describe, expect, it } from 'vitest'
import { RECENT_CAP, rekeyRecent, touchRecent } from '../src/renderer/lib/recentTabs'

describe('touchRecent', () => {
  it('moves an id to the front without duplicating it', () => {
    expect(touchRecent(['A', 'B', 'C', 'D'], 'C')).toEqual(['C', 'A', 'B', 'D'])
  })

  it('adds a new id at the front', () => {
    expect(touchRecent(['A', 'B'], 'X')).toEqual(['X', 'A', 'B'])
  })

  it('returns the same list when the id is already first', () => {
    // Called on every render; identity is what makes that free.
    const list = ['A', 'B']
    expect(touchRecent(list, 'A')).toBe(list)
  })

  it('drops the oldest past the cap', () => {
    const full = Array.from({ length: RECENT_CAP }, (_, i) => `s${i}`)
    const next = touchRecent(full, 'new')
    expect(next).toHaveLength(RECENT_CAP)
    expect(next[0]).toBe('new')
    expect(next[1]).toBe('s0')
    expect(next).not.toContain(`s${RECENT_CAP - 1}`)
  })
})

describe('rekeyRecent', () => {
  it('renames the id in place', () => {
    expect(rekeyRecent(['A', 'P', 'B'], 'P', 'R')).toEqual(['A', 'R', 'B'])
  })

  it('keeps the more recent position when the new id was already listed', () => {
    expect(rekeyRecent(['A', 'P', 'B', 'R', 'C'], 'P', 'R')).toEqual(['A', 'R', 'B', 'C'])
    expect(rekeyRecent(['A', 'R', 'B', 'P', 'C'], 'P', 'R')).toEqual(['A', 'R', 'B', 'C'])
  })

  it('returns the same list when the old id is absent', () => {
    const list = ['A', 'B']
    expect(rekeyRecent(list, 'P', 'R')).toBe(list)
  })
})
