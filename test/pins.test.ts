import { describe, it, expect } from 'vitest'
import { moveBetween, moveManyBetween, reorderArray, withPins } from '../src/renderer/lib/reorder'

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

describe('moveBetween', () => {
  // One folder's pins are a, b, c; x and y are other folders' pins between them in the app-wide
  // list, so a folder's neighbors are NOT adjacent there. Every expectation below is a whole order.
  const base = ['a', 'x', 'b', 'y', 'c']

  it('lands directly above the lower neighbor, not directly below the higher one', () => {
    // Below `a` would give [a, c, x, b, y]; the two readings differ only when the neighbors are
    // separated, which is why the fixture separates them.
    expect(moveBetween(base, 'c', 'a', 'b')).toEqual(['a', 'x', 'c', 'b', 'y'])
  })

  it('lands directly below the higher neighbor when dropped last', () => {
    expect(moveBetween(base, 'a', 'c', null)).toEqual(['x', 'b', 'y', 'c', 'a'])
  })

  it('lands directly above the lower neighbor when dropped first', () => {
    expect(moveBetween(base, 'c', null, 'a')).toEqual(['c', 'a', 'x', 'b', 'y'])
  })

  it('returns the same array when the item would not move', () => {
    expect(moveBetween(base, 'b', 'x', 'y')).toBe(base)
  })

  it('returns the same array for an unknown item or unknown neighbors', () => {
    expect(moveBetween(base, 'z', 'a', 'b')).toBe(base)
    // The LAST item, so a fallback to any fixed slot would move it and show.
    expect(moveBetween(base, 'c', 'q', 'r')).toBe(base)
    expect(moveBetween(base, 'c', null, null)).toBe(base)
  })
})

describe('moveManyBetween', () => {
  // One folder's pins are a, b, c, d; x and y are other folders' pins between them.
  const base = ['a', 'x', 'b', 'y', 'c', 'd']

  it('lands the group contiguous above the lower neighbor, in the order it had', () => {
    // Asked for d before b, but b sits above d in the list, so b lands first.
    expect(moveManyBetween(base, ['d', 'b'], 'a', 'c')).toEqual(['a', 'x', 'y', 'b', 'd', 'c'])
  })

  it('lands below the higher neighbor when dropped last, and above the lower one when dropped first', () => {
    expect(moveManyBetween(base, ['a', 'b'], 'd', null)).toEqual(['x', 'y', 'c', 'd', 'a', 'b'])
    expect(moveManyBetween(base, ['c', 'd'], null, 'a')).toEqual(['c', 'd', 'a', 'x', 'b', 'y'])
  })

  it('ignores ids the list does not hold', () => {
    expect(moveManyBetween(base, ['q', 'd'], null, 'a')).toEqual(['d', 'a', 'x', 'b', 'y', 'c'])
  })

  it('returns the same array when nothing would move', () => {
    expect(moveManyBetween(base, ['c', 'd'], 'y', null)).toBe(base)
    expect(moveManyBetween(base, ['q'], 'a', 'b')).toBe(base)
    // The LAST items, so a fallback to any fixed slot would move them and show.
    expect(moveManyBetween(base, ['c', 'd'], 'q', 'r')).toBe(base)
  })
})

describe('withPins', () => {
  const base = ['a', 'b']

  it('pins appends what is not pinned yet, in the order given, once each', () => {
    expect(withPins(base, ['d', 'b', 'c', 'd'], true)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('unpins removes them wherever they sit', () => {
    expect(withPins(['a', 'b', 'c'], ['c', 'a'], false)).toEqual(['b'])
  })

  it('returns the same array when every one is already as asked — a set, never a toggle', () => {
    expect(withPins(base, ['b', 'a'], true)).toBe(base)
    expect(withPins(base, ['c'], false)).toBe(base)
  })
})
