import { describe, expect, it } from 'vitest'
import {
  absorbBind,
  bumpRank,
  compareRanked,
  dropWrites,
  parseRanks,
  rankOf,
  topRank,
  type Ranked
} from '../src/renderer/lib/rowRank'

/**
 * Real timestamp magnitudes throughout: float spacing is ~2.4e-4 ms at this size, and whether a
 * midpoint still fits between its neighbors is exactly what several of these tests are about. Small
 * integers would pass every one of them against an implementation with no re-spacing at all.
 */
const T = 1_780_000_000_000

/** Apply writes to a space and return its ids in display order — tests assert whole orders. */
function orderAfter(space: readonly Ranked[], writes: Record<string, number>): string[] {
  return space
    .map((e) => (Object.hasOwn(writes, e.id) ? { id: e.id, rank: writes[e.id] } : e))
    .sort(compareRanked)
    .map((e) => e.id)
}

function apply(space: Ranked[], writes: Record<string, number>): Ranked[] {
  return space.map((e) => (Object.hasOwn(writes, e.id) ? { id: e.id, rank: writes[e.id] } : e))
}

describe('rankOf', () => {
  it('prefers an override to the seed', () => {
    expect(rankOf('a', T, { a: T - 5 })).toBe(T - 5)
    expect(rankOf('b', T, { a: T - 5 })).toBe(T)
  })

  it('does not read inherited members as overrides', () => {
    const parsed = parseRanks('{"a":1}')
    expect(rankOf('constructor', T, parsed)).toBe(T)
    expect(rankOf('toString', T, parsed)).toBe(T)
  })
})

describe('compareRanked', () => {
  it('orders descending and breaks ties by id, in both argument orders', () => {
    const rows = [
      { id: 'b', rank: T },
      { id: 'c', rank: T + 1 },
      { id: 'a', rank: T }
    ]
    expect([...rows].sort(compareRanked).map((r) => r.id)).toEqual(['c', 'a', 'b'])
    expect([...rows].reverse().sort(compareRanked).map((r) => r.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('topRank', () => {
  it('is the highest rank wherever it sits, and null for an empty space', () => {
    expect(topRank([])).toBeNull()
    expect(
      topRank([
        { id: 'a', rank: T - 5 },
        { id: 'b', rank: T + 3 },
        { id: 'c', rank: T }
      ])
    ).toBe(T + 3)
  })
})

describe('bumpRank', () => {
  it('lands on the clock when everything is older', () => {
    expect(bumpRank(T - 60_000, T)).toBe(T)
    expect(bumpRank(null, T)).toBe(T)
  })

  it('lands above a row that is ahead of the clock', () => {
    // A previous Resume in the same millisecond, or a row dragged to the top, can sit at or past now.
    expect(bumpRank(T, T)).toBe(T + 1)
    expect(bumpRank(T + 40, T)).toBe(T + 41)
  })

  it('leaves a conversation started after the Resume above it', () => {
    const resumed = bumpRank(T - 1000, T)
    const space = [
      { id: 'resumed', rank: resumed },
      { id: 'newer', rank: T + 5000 },
      { id: 'old', rank: T - 1000 }
    ]
    expect([...space].sort(compareRanked).map((r) => r.id)).toEqual(['newer', 'resumed', 'old'])
  })
})

describe('dropWrites', () => {
  const space: Ranked[] = [
    { id: 'a', rank: T - 1000 },
    { id: 'b', rank: T - 2000 },
    { id: 'c', rank: T - 3000 },
    { id: 'd', rank: T - 4000 }
  ]

  it('writes one key at the midpoint for an interior drop', () => {
    const writes = dropWrites(space, 'd', 'a', 'b', T)
    expect(writes).toEqual({ d: T - 1500 })
    expect(orderAfter(space, writes)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('drops at the top like a Resume: never behind the clock', () => {
    const writes = dropWrites(space, 'c', null, 'a', T)
    expect(writes).toEqual({ c: T })
    expect(orderAfter(space, writes)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('drops at the top above a row that is ahead of the clock', () => {
    const ahead = [...space, { id: 'e', rank: T + 50 }]
    const writes = dropWrites(ahead, 'c', null, 'e', T)
    expect(writes).toEqual({ c: T + 51 })
    expect(orderAfter(ahead, writes)).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('drops at the bottom one below the row above', () => {
    const writes = dropWrites(space, 'a', 'd', null, T)
    expect(writes).toEqual({ a: T - 4001 })
    expect(orderAfter(space, writes)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('writes nothing with no neighbors', () => {
    expect(dropWrites([{ id: 'a', rank: T }], 'a', null, null, T)).toEqual({})
  })

  it('places a folder drop among the other folders in All mode', () => {
    // Folder X holds x1, x2, x3; folder Y holds y1, y2. Dropping x3 between x1 and x2 inside X writes
    // a midpoint that also decides where x3 falls among Y's rows in the All list.
    const mixed: Ranked[] = [
      { id: 'x1', rank: T - 1000 },
      { id: 'y1', rank: T - 1200 },
      { id: 'y2', rank: T - 1800 },
      { id: 'x2', rank: T - 2000 },
      { id: 'x3', rank: T - 9000 }
    ]
    const writes = dropWrites(mixed, 'x3', 'x1', 'x2', T)
    expect(writes).toEqual({ x3: T - 1500 })
    expect(orderAfter(mixed, writes)).toEqual(['x1', 'y1', 'x3', 'y2', 'x2'])
  })

  it('re-spaces when the neighbors are adjacent floats', () => {
    const tight: Ranked[] = [
      { id: 'a', rank: T },
      { id: 'b', rank: T - 2 ** -12 },
      { id: 'x', rank: T - 5000 }
    ]
    expect(T - 2 ** -12).not.toBe(T) // the fixture really is two distinct adjacent floats
    const writes = dropWrites(tight, 'x', 'a', 'b', T)
    expect(Object.keys(writes).length).toBeGreaterThan(1)
    expect(orderAfter(tight, writes)).toEqual(['a', 'x', 'b'])
  })

  it('re-spaces between tied ranks, keeping the tie order', () => {
    const tied: Ranked[] = [
      { id: 'a', rank: T },
      { id: 'b', rank: T },
      { id: 'x', rank: T - 5000 }
    ]
    expect(orderAfter(tied, dropWrites(tied, 'x', 'a', 'b', T))).toEqual(['a', 'x', 'b'])
  })

  it('survives dropping into one gap until it must re-space, preserving every other row globally', () => {
    // Block P: p-top and p-bottom, one millisecond apart; block Q's rows sit around and BETWEEN them.
    // Every new row is dropped directly under p-top inside P, halving the same gap until floats run
    // out. Re-spacing must keep Q's rows exactly where they were relative to everything — an
    // implementation that re-spaced within the block alone would pass every per-block check and
    // still reshuffle the All list.
    let ranks: Ranked[] = [
      { id: 'q-above', rank: T + 10 },
      { id: 'p-top', rank: T + 1 },
      { id: 'q-between', rank: T + 0.5 },
      { id: 'p-bottom', rank: T },
      { id: 'q-below', rank: T - 10 }
    ]
    const blockP = new Set(['p-top', 'p-bottom'])
    let respaced = false
    let lastInserted = 'p-bottom'
    for (let i = 0; i < 40; i++) {
      const id = `n${i}`
      ranks.push({ id, rank: T - 100_000 - i })
      blockP.add(id)
      const before = [...ranks].sort(compareRanked).map((r) => r.id).filter((r) => r !== id)
      const writes = dropWrites(ranks, id, 'p-top', lastInserted, T + 100)
      if (Object.keys(writes).length > 1) respaced = true
      ranks = apply(ranks, writes)
      const after = [...ranks].sort(compareRanked).map((r) => r.id)
      // Every pre-existing row keeps its global relative order...
      expect(after.filter((r) => r !== id)).toEqual(before)
      // ...and inside block P the new row sits directly under p-top.
      const p = after.filter((r) => blockP.has(r))
      expect(p.slice(0, 2)).toEqual(['p-top', id])
      lastInserted = id
    }
    expect(respaced).toBe(true)
  })
})

describe('absorbBind', () => {
  it('transfers the SEED of a placeholder that was never dragged', () => {
    // The terminal started at T; its real conversation's first message came at T+3000; another
    // conversation started at T+1000. Transferring nothing would let the real id's own seed put it
    // above the conversation started in between — a jump on bind.
    const next = absorbBind({}, T, 'placeholder', 'real')
    expect(next).toEqual({ real: T })
    const space = [
      { id: 'real', rank: rankOf('real', T + 3000, next) },
      { id: 'between', rank: T + 1000 },
      { id: 'older', rank: T - 1000 }
    ]
    expect([...space].sort(compareRanked).map((r) => r.id)).toEqual(['between', 'real', 'older'])
  })

  it('moves a dragged placeholder position and removes the placeholder key', () => {
    const next = absorbBind({ placeholder: T - 7, other: T - 3 }, T - 7, 'placeholder', 'real')
    expect(next).toEqual({ real: T - 7, other: T - 3 })
  })

  it('takes a dragged placeholder position from the store, over what this window rendered', () => {
    // Every window folds the bind into a fresh read; a window behind on renders passes a stale rank.
    const next = absorbBind({ placeholder: T - 7, other: T - 3 }, T, 'placeholder', 'real')
    expect(next).toEqual({ real: T - 7, other: T - 3 })
  })

  it('lets a dragged placeholder position beat one the destination carries', () => {
    const next = absorbBind({ placeholder: T - 7, real: T + 99 }, T - 7, 'placeholder', 'real')
    expect(next).toEqual({ real: T - 7 })
  })

  it('leaves a transfer another window already made', () => {
    // Window A moved the dragged position T-7 onto `real`. Window B, whose model had already caught
    // up with that write, sees the placeholder at its seed T — writing that would lose the drag.
    const transferred = Object.freeze({ real: T - 7, other: T - 3 })
    expect(absorbBind(transferred, T, 'placeholder', 'real')).toBe(transferred)
  })

  it('does not mutate its input and is a no-op for equal ids', () => {
    const before = Object.freeze({ placeholder: T - 7 })
    expect(absorbBind(before, T - 7, 'placeholder', 'placeholder')).toBe(before)
    absorbBind(before, T - 7, 'placeholder', 'real')
    expect(before).toEqual({ placeholder: T - 7 })
  })
})

describe('parseRanks', () => {
  it('reads a stored map', () => {
    expect(parseRanks(JSON.stringify({ a: T, b: T - 1.5 }))).toEqual({ a: T, b: T - 1.5 })
  })

  it('drops entries that are not finite numbers', () => {
    expect(parseRanks('{"a":1,"b":"2","c":null,"d":true,"e":[1]}')).toEqual({ a: 1 })
  })

  it('reads anything malformed as empty', () => {
    for (const raw of [null, '', 'not json', '[1,2]', '42', 'null', '"x"']) expect(parseRanks(raw)).toEqual({})
  })
})
