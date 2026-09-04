import { describe, expect, it } from 'vitest'
import { DEFAULT_TABS_ENABLED, parseTabsEnabled } from '../src/renderer/lib/tabsPreference'

describe('parseTabsEnabled', () => {
  // The property being reserved: absence means "never chose", so it must follow the CONSTANT
  // rather than a hardcoded value. Flipping the default later reaches exactly this population, and
  // a literal here would silently strand that flip while every other test still passed.
  it('follows the default when nothing has been stored', () => {
    expect(parseTabsEnabled(null)).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('')).toBe(DEFAULT_TABS_ENABLED)
  })

  it('honours an explicit choice in either direction', () => {
    expect(parseTabsEnabled('{"enabled":true}')).toBe(true)
    expect(parseTabsEnabled('{"enabled":false}')).toBe(false)
  })

  // The rule stated at a default of TRUE, which is the only way to observe it. With the default
  // at `false`, "absence follows the default" and "always returns false" agree on every input, so
  // a test that only ever sees today's default cannot tell a correct implementation from one that
  // ignores the default entirely — and that is exactly the implementation which would silently
  // strand a future flip.
  it('follows a flipped default for absence without disturbing explicit choices', () => {
    expect(parseTabsEnabled(null, true)).toBe(true)
    expect(parseTabsEnabled('', true)).toBe(true)
    expect(parseTabsEnabled('not json', true)).toBe(true)
    expect(parseTabsEnabled('{}', true)).toBe(true)
    // An explicit off must SURVIVE the flip — that is the whole point of storing a choice.
    expect(parseTabsEnabled('{"enabled":false}', true)).toBe(false)
  })

  it('falls back to the default for malformed or incomplete records', () => {
    expect(parseTabsEnabled('not json')).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('{}')).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('{"enabled":"yes"}')).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('{"enabled":1}')).toBe(DEFAULT_TABS_ENABLED)
  })
})
