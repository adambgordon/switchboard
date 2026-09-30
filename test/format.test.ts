import { describe, expect, it } from 'vitest'
import { formatBytes, formatCount, formatMetric } from '../src/renderer/lib/format'

describe('formatMetric', () => {
  it('leaves a count under a thousand as it is', () => {
    expect(formatMetric(942)).toBe('942')
  })

  it('names thousands, millions and billions K, M and B', () => {
    expect(formatMetric(5_200)).toBe('5.2K')
    expect(formatMetric(18_389_031)).toBe('18.4M')
    expect(formatMetric(1_234_567_890)).toBe('1.2B')
  })

  it('keeps one decimal under 100 of a unit, and drops it from 100 up', () => {
    expect(formatMetric(12_000_000_000)).toBe('12B')
    expect(formatMetric(324_315)).toBe('324K')
  })

  it('leaves sizes to formatBytes, which keeps GB', () => {
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB')
  })
})

describe('formatCount', () => {
  it('groups thousands with commas', () => {
    expect(formatCount(1057)).toBe('1,057')
    expect(formatCount(1_234_567)).toBe('1,234,567')
  })

  it('leaves a count under a thousand as it is', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
  })
})
