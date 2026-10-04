import { describe, expect, it } from 'vitest'
import {
  admits,
  hiddenBy,
  parseHiddenSet,
  withHidden,
  type RailCriterion,
  type RowFacts
} from '../src/renderer/lib/railFilter'

const ROWS: Record<string, RowFacts> = {
  idle: { hidden: false, live: false },
  live: { hidden: false, live: true },
  hiddenIdle: { hidden: true, live: false },
  hiddenLive: { hidden: true, live: true }
}

/** The rows a filter admits, by name — the whole truth table for one filter in one comparable line. */
const admitted = (...criteria: RailCriterion[]): string[] =>
  Object.entries(ROWS)
    .filter(([, facts]) => admits(new Set(criteria), facts))
    .map(([name]) => name)

describe('admits', () => {
  it('with no filter, shows everything not hidden, running or not', () => {
    expect(admitted()).toEqual(['idle', 'live'])
  })

  it('Hidden swaps the side: only what is hidden, running or not', () => {
    expect(admitted('hidden')).toEqual(['hiddenIdle', 'hiddenLive'])
  })

  it('Live narrows what is not hidden, and never brings a hidden row back', () => {
    expect(admitted('live')).toEqual(['live'])
  })

  it('Hidden and Live together is what is both', () => {
    expect(admitted('hidden', 'live')).toEqual(['hiddenLive'])
  })
})

describe('hiddenBy', () => {
  const hidden = { rows: new Set(['own', 'both']), folders: new Set(['/w/gone']) }

  it('names the folder first, since unhiding the conversation alone would not bring it back', () => {
    expect(hiddenBy(hidden, 'both', '/w/gone')).toBe('folder')
    expect(hiddenBy(hidden, 'other', '/w/gone')).toBe('folder')
  })

  it('names the conversation when only it is hidden', () => {
    expect(hiddenBy(hidden, 'own', '/w/kept')).toBe('self')
  })

  it('is null when neither is', () => {
    expect(hiddenBy(hidden, 'other', '/w/kept')).toBeNull()
  })
})

describe('the stored sets', () => {
  it('reads a JSON array of strings, dropping anything else in it', () => {
    expect([...parseHiddenSet('["a", 3, null, "b", "a"]')]).toEqual(['a', 'b'])
  })

  it('reads as empty from nothing, bad JSON, or a value that is not an array', () => {
    expect(parseHiddenSet(null).size).toBe(0)
    expect(parseHiddenSet('').size).toBe(0)
    expect(parseHiddenSet('[').size).toBe(0)
    expect(parseHiddenSet('{"a": true}').size).toBe(0)
    expect(parseHiddenSet('"a"').size).toBe(0)
  })

  it('hides and unhides one key, leaving the rest', () => {
    const stored = new Set(['a', 'b'])
    expect([...withHidden(stored, 'c', true)]).toEqual(['a', 'b', 'c'])
    expect([...withHidden(stored, 'a', false)]).toEqual(['b'])
  })

  it('returns the stored set itself when nothing changes, either way', () => {
    // The hook writes only when the set changed, so an unchanged fold must be recognizable.
    const stored = new Set(['a'])
    expect(withHidden(stored, 'a', true)).toBe(stored)
    expect(withHidden(stored, 'b', false)).toBe(stored)
  })
})
