import { describe, it, expect } from 'vitest'
import { resolveTheme } from '../src/renderer/lib/theme'

describe('resolveTheme', () => {
  it('explicit light is always light, regardless of the OS', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
  })

  it('explicit dark is always dark, regardless of the OS', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('system follows the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})
