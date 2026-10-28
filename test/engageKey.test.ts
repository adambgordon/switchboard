import { describe, expect, it } from 'vitest'
import { isEngagingKey } from '../src/renderer/lib/engageKey'

interface Mods {
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

// Flags as a real keydown reports them: pressing ⌥ alone already has `altKey` set, and ⇧ `shiftKey`.
const key = (key: string, mods: Mods = {}) => ({
  key,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false,
  altKey: mods.altKey ?? false,
  shiftKey: mods.shiftKey ?? false
})

describe('isEngagingKey', () => {
  it('counts ordinary typing', () => {
    expect(isEngagingKey(key('a'))).toBe(true)
    expect(isEngagingKey(key('Enter'))).toBe(true)
    expect(isEngagingKey(key('ArrowUp'))).toBe(true)
  })

  // The lead-ins to ⌥-click (mark unread) and ⇧-click (pick a range).
  it.each([
    ['Alt', { altKey: true }],
    ['Shift', { shiftKey: true }],
    ['AltGraph', { altKey: true }],
    ['CapsLock', {}],
    ['Fn', {}]
  ])('does not count %s pressed alone', (k, mods) => {
    expect(isEngagingKey(key(k, mods))).toBe(false)
  })

  // ⌥ and ⇧ change the character a key produces; the result is still input, so the held flag must
  // not be what decides it.
  it('counts a key typed with ⌥ or ⇧ held', () => {
    expect(isEngagingKey(key('å', { altKey: true }))).toBe(true)
    expect(isEngagingKey(key('A', { shiftKey: true }))).toBe(true)
  })

  it('does not count ⌘ or Ctrl chords', () => {
    expect(isEngagingKey(key('U', { metaKey: true, shiftKey: true }))).toBe(false)
    expect(isEngagingKey(key('c', { ctrlKey: true }))).toBe(false)
  })

  it('does not count ⌘ or Ctrl pressed alone', () => {
    expect(isEngagingKey(key('Meta', { metaKey: true }))).toBe(false)
    expect(isEngagingKey(key('Control', { ctrlKey: true }))).toBe(false)
  })
})
