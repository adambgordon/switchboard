import { describe, expect, it } from 'vitest'
import { DEFAULT_TAB_LAYOUT, parseTabLayout } from '../src/renderer/lib/tabLayoutPreference'

describe('tab layout preference', () => {
  it('defaults to wrapping for existing profiles', () => {
    expect(DEFAULT_TAB_LAYOUT).toBe('wrap')
    expect(parseTabLayout(null)).toBe('wrap')
  })

  it('retains either explicit choice independently of the fallback', () => {
    expect(parseTabLayout('scroll', 'wrap')).toBe('scroll')
    expect(parseTabLayout('wrap', 'scroll')).toBe('wrap')
  })

  it.each([null, '', 'stack', 'false', '{}', '"scroll"'])('uses the supplied default for %s', (raw) => {
    expect(parseTabLayout(raw, 'scroll')).toBe('scroll')
    expect(parseTabLayout(raw, 'wrap')).toBe('wrap')
  })
})
