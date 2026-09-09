import { describe, expect, it } from 'vitest'
import { appendUpdateLog, MAX_UPDATE_LOG_CHARS } from '../src/shared/updateLog'

describe('appendUpdateLog', () => {
  it('appends ordinary update output', () => {
    expect(appendUpdateLog('one\n', 'two\n')).toBe('one\ntwo\n')
  })

  it('keeps only the newest bounded output', () => {
    const old = 'a'.repeat(MAX_UPDATE_LOG_CHARS - 2)
    expect(appendUpdateLog(old, 'NEW')).toBe(`${'a'.repeat(MAX_UPDATE_LOG_CHARS - 3)}NEW`)
  })
})
