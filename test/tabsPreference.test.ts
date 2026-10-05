import { describe, expect, it } from 'vitest'
import { DEFAULT_TABS_ENABLED, parseTabsEnabled } from '../src/renderer/lib/tabsPreference'

describe('parseTabsEnabled', () => {
  // The property being reserved: absence means "never chose", so it must follow the CONSTANT
  // rather than a hardcoded value. A change of default reaches exactly this population, and a
  // literal here would silently strand it while every other test still passed.
  it('follows the default when nothing has been stored', () => {
    expect(parseTabsEnabled(null)).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('')).toBe(DEFAULT_TABS_ENABLED)
  })

  it('honors an explicit choice in either direction', () => {
    expect(parseTabsEnabled('{"enabled":true}')).toBe(true)
    expect(parseTabsEnabled('{"enabled":false}')).toBe(false)
  })

  // The rule stated at BOTH fallbacks, which is the only way to observe it. At any one default,
  // "absence follows the default" and "always returns that value" agree on every input, so a test
  // that only ever sees today's default cannot tell a correct implementation from one that ignores
  // the fallback entirely.
  it('follows the fallback for absence, whichever it is, without disturbing explicit choices', () => {
    for (const fallback of [true, false]) {
      expect(parseTabsEnabled(null, fallback)).toBe(fallback)
      expect(parseTabsEnabled('', fallback)).toBe(fallback)
      expect(parseTabsEnabled('not json', fallback)).toBe(fallback)
      expect(parseTabsEnabled('{}', fallback)).toBe(fallback)
      // An explicit choice must SURVIVE a change of default — that is the whole point of storing it.
      expect(parseTabsEnabled('{"enabled":false}', fallback)).toBe(false)
      expect(parseTabsEnabled('{"enabled":true}', fallback)).toBe(true)
    }
  })

  it('falls back to the default for malformed or incomplete records', () => {
    expect(parseTabsEnabled('not json')).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('{}')).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('{"enabled":"yes"}')).toBe(DEFAULT_TABS_ENABLED)
    expect(parseTabsEnabled('{"enabled":1}')).toBe(DEFAULT_TABS_ENABLED)
  })
})
