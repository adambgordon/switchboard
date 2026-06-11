import { describe, expect, it } from 'vitest'
import { findMatches } from '../src/renderer/lib/findMatches'

describe('findMatches', () => {
  it('finds a single occurrence with correct [start, end) offsets', () => {
    expect(findMatches('hello world', 'world')).toEqual([[6, 11]])
  })

  it('finds every non-overlapping occurrence', () => {
    expect(findMatches('the cat sat on the mat', 'at')).toEqual([
      [5, 7],
      [9, 11],
      [20, 22]
    ])
  })

  it('matches case-insensitively', () => {
    expect(findMatches('Foo FOO foo', 'foo')).toEqual([
      [0, 3],
      [4, 7],
      [8, 11]
    ])
  })

  it('advances past each match so they never overlap', () => {
    expect(findMatches('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4]
    ])
  })

  it('returns nothing for an empty or whitespace-only needle', () => {
    expect(findMatches('anything', '')).toEqual([])
    expect(findMatches('anything', '   ')).toEqual([])
  })

  it('returns nothing when there is no match', () => {
    expect(findMatches('hello', 'zzz')).toEqual([])
  })

  it('matches internal whitespace literally (multi-word query)', () => {
    expect(findMatches('a foo bar b', 'foo bar')).toEqual([[2, 9]])
  })
})
