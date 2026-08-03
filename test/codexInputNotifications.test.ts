import { describe, expect, it } from 'vitest'
import { CodexInputNotificationScanner } from '../src/main/pty/codexInputNotifications'

const osc9 = (message: string): string => `\x1b]9;${message}\x07`

describe('CodexInputNotificationScanner', () => {
  it.each([
    'Plan mode prompt: Choice',
    'Approval requested: git push',
    'Codex wants to edit src/main.ts',
    'Approval requested by github'
  ])('recognizes %s', (message) => {
    const scanner = new CodexInputNotificationScanner()
    expect(scanner.push(osc9(message))).toBe(true)
  })

  it('recognizes a sequence split at every byte boundary', () => {
    const sequence = osc9('Approval requested: npm test')
    for (let split = 1; split < sequence.length; split += 1) {
      const scanner = new CodexInputNotificationScanner()
      expect(scanner.push(sequence.slice(0, split))).toBe(false)
      expect(scanner.push(sequence.slice(split))).toBe(true)
    }
  })

  it('recognizes multiple sequences in one chunk', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(
      scanner.push(
        osc9('Agent turn complete') +
          osc9('Approval requested: git push') +
          osc9('Plan mode prompt: Choice')
      )
    ).toBe(true)
  })

  it('recognizes Codex tmux DCS wrapping', () => {
    const scanner = new CodexInputNotificationScanner()
    const wrapped = '\x1bPtmux;\x1b\x1b]9;Approval requested: git push\x07\x1b\\'
    expect(scanner.push(wrapped)).toBe(true)
  })

  it('accepts the OSC string terminator as well as BEL', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(scanner.push('\x1b]9;Plan mode prompt: Choice\x1b\\')).toBe(true)
  })

  it('ignores malformed and unterminated sequences', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(scanner.push('\x1b]9Plan mode prompt: Choice\x07')).toBe(false)
    expect(scanner.push('\x1b]9;Plan mode prompt: Choice')).toBe(false)
    expect(scanner.push(osc9('Agent turn complete'))).toBe(false)
  })

  it('recovers from an unterminated sequence before a valid notification', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(scanner.push('\x1b]9;Agent turn complete')).toBe(false)
    expect(scanner.push(osc9('Approval requested: git push'))).toBe(true)
  })

  it('bounds an oversized partial sequence and recovers for the next notification', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(scanner.push('\x1b]9;Approval requested: ' + 'x'.repeat(5000))).toBe(false)
    expect(scanner.push('\x07' + osc9('Plan mode prompt: Choice'))).toBe(true)
  })

  it('recovers from an oversized malformed sequence before a valid one in the same chunk', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(
      scanner.push(
        '\x1b]9;Approval requested: ' +
          'x'.repeat(5000) +
          osc9('Approval requested by github')
      )
    ).toBe(true)
  })

  it('ignores visible text that resembles a notification', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(scanner.push('Approval requested: git push')).toBe(false)
  })

  it('ignores unrelated OSC sequences and notification types', () => {
    const scanner = new CodexInputNotificationScanner()
    expect(scanner.push('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')).toBe(false)
    expect(scanner.push(osc9('Agent turn complete'))).toBe(false)
  })
})
