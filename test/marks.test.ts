import { describe, expect, it } from 'vitest'
import { advanceMark, clearMark, rekeyMark, setMark } from '../src/renderer/lib/marks'

/**
 * The read/unread marker merges.
 *
 * Two things are pinned here, and the second is the unusual one.
 *
 * The rules: a `seen` marker may only move forward (it is compared against a turn's end time, so
 * moving one back makes a conversation the user has read start reporting itself unread), and a rekey
 * must not leave the old id behind.
 *
 * The IDENTITY contract: every function returns its input object itself when nothing changed. That is
 * not a micro-optimisation — the caller applies these to what is on DISK, and uses `next === stored`
 * to decide whether to write at all. A merge that returned a fresh equal object would make every
 * no-op mutation write the whole map back and re-render, which is precisely the behaviour that let one
 * window's save revert another's markers.
 */

describe('advanceMark', () => {
  it('sets a marker that was absent', () => {
    expect(advanceMark({}, 'a', 100)).toEqual({ a: 100 })
  })

  it('moves a marker forward', () => {
    expect(advanceMark({ a: 100 }, 'a', 200)).toEqual({ a: 200 })
  })

  it('never moves a marker backward, and returns the input unchanged', () => {
    const prev = { a: 200 }
    expect(advanceMark(prev, 'a', 100)).toBe(prev)
    // Equal is also unchanged — writing the same value is still a write.
    expect(advanceMark(prev, 'a', 200)).toBe(prev)
  })

  it('leaves other conversations alone', () => {
    expect(advanceMark({ a: 100, b: 50 }, 'a', 200)).toEqual({ a: 200, b: 50 })
  })
})

describe('setMark', () => {
  it('overwrites in either direction — the latest manual act wins', () => {
    // Distinct from advanceMark ON PURPOSE: marking unread is deliberate, so it is not forward-only.
    expect(setMark({ a: 200 }, 'a', 100)).toEqual({ a: 100 })
    expect(setMark({ a: 100 }, 'a', 200)).toEqual({ a: 200 })
  })

  it('returns the input unchanged when the value already matches', () => {
    const prev = { a: 100 }
    expect(setMark(prev, 'a', 100)).toBe(prev)
  })
})

describe('clearMark', () => {
  it('removes a marker', () => {
    expect(clearMark({ a: 100, b: 50 }, 'a')).toEqual({ b: 50 })
  })

  it('returns the input unchanged when there is nothing to remove', () => {
    const prev = { b: 50 }
    expect(clearMark(prev, 'a')).toBe(prev)
  })
})

describe('rekeyMark', () => {
  it('moves the marker and drops the old id', () => {
    const next = rekeyMark({ old: 100, other: 50 }, 'old', 'new')
    expect(next).toEqual({ new: 100, other: 50 })
    // Asserted explicitly: a copy that left `old` in place would satisfy a check for `new` alone, and
    // those entries accumulate for the life of the store.
    expect('old' in next).toBe(false)
  })

  it('keeps the LATER marker when the new id already has one', () => {
    // Both describe the same conversation, so the newer reading is the true one. Asserted in both
    // directions, so an implementation that simply overwrote either way cannot pass.
    expect(rekeyMark({ old: 100, new: 300 }, 'old', 'new')).toEqual({ new: 300 })
    expect(rekeyMark({ old: 300, new: 100 }, 'old', 'new')).toEqual({ new: 300 })
  })

  it('returns the input unchanged when there is nothing under the old id', () => {
    const prev = { other: 50 }
    expect(rekeyMark(prev, 'old', 'new')).toBe(prev)
  })

  it('returns the input unchanged when the ids are the same', () => {
    // Guards against deleting the key and then reading the deleted value back.
    const prev = { a: 100 }
    expect(rekeyMark(prev, 'a', 'a')).toBe(prev)
  })
})
