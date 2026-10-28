import { describe, expect, it } from 'vitest'
import { isEngagingKey } from '../src/renderer/lib/engageKey'

const key = (key: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
  key,
  metaKey: mods.metaKey ?? false,
  ctrlKey: mods.ctrlKey ?? false
})

describe('isEngagingKey', () => {
  it('counts ordinary typing', () => {
    expect(isEngagingKey(key('a'))).toBe(true)
    expect(isEngagingKey(key('Enter'))).toBe(true)
    expect(isEngagingKey(key('ArrowUp'))).toBe(true)
  })

  // The lead-ins to ⌥-click (mark unread) and ⇧-click (pick a range).
  it.each(['Alt', 'Shift', 'AltGraph', 'CapsLock', 'Fn'])('does not count %s pressed alone', (k) => {
    expect(isEngagingKey(key(k))).toBe(false)
  })

  // ⌥ and ⇧ change the character a key produces; the result is still input.
  it('counts a key typed with ⌥ or ⇧ held', () => {
    expect(isEngagingKey(key('å'))).toBe(true)
    expect(isEngagingKey(key('A'))).toBe(true)
  })

  it('does not count ⌘ or Ctrl chords', () => {
    expect(isEngagingKey(key('U', { metaKey: true }))).toBe(false)
    expect(isEngagingKey(key('c', { ctrlKey: true }))).toBe(false)
  })

  it('does not count ⌘ or Ctrl pressed alone', () => {
    expect(isEngagingKey(key('Meta', { metaKey: true }))).toBe(false)
    expect(isEngagingKey(key('Control', { ctrlKey: true }))).toBe(false)
  })
})
