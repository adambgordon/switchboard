import { describe, it, expect } from 'vitest'
import { reorderArray } from '../src/renderer/lib/usePins'

describe('reorderArray', () => {
  const base = ['a', 'b', 'c', 'd']

  it('moves an item down to a later index', () => {
    expect(reorderArray(base, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves an item up to an earlier index', () => {
    expect(reorderArray(base, 2, 0)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('moves the first item to the end', () => {
    expect(reorderArray(base, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('moves the last item to the front', () => {
    expect(reorderArray(base, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('returns the SAME array reference on a no-op (from === to)', () => {
    expect(reorderArray(base, 1, 1)).toBe(base)
  })

  it('returns the same reference for out-of-range indices', () => {
    expect(reorderArray(base, -1, 2)).toBe(base)
    expect(reorderArray(base, 1, 9)).toBe(base)
    expect(reorderArray(base, 9, 1)).toBe(base)
  })

  it('does not mutate the input', () => {
    const copy = base.slice()
    reorderArray(base, 0, 2)
    expect(base).toEqual(copy)
  })
})
