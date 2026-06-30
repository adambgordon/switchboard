import { describe, it, expect } from 'vitest'
import { bootCommandFor, bootPayloadFor } from '../src/main/pty/bootCommand'

const ID = 'eb583f11-9020-45a7-af51-b23f2e2cb3cc'
const CLEAR = '\x05\x15' // Ctrl-E + Ctrl-U — kill whatever is on the input line

describe('bootCommandFor', () => {
  it('claude new uses a pre-assigned --session-id', () => {
    expect(bootCommandFor('claude', 'new', ID)).toBe(`claude --session-id ${ID}`)
  })
  it('claude resume uses --resume', () => {
    expect(bootCommandFor('claude', 'resume', ID)).toBe(`claude --resume ${ID}`)
  })
  it('codex new is a bare codex (it mints its own id)', () => {
    expect(bootCommandFor('codex', 'new', ID)).toBe('codex')
  })
  it('codex resume uses codex resume <id>', () => {
    expect(bootCommandFor('codex', 'resume', ID)).toBe(`codex resume ${ID}`)
  })
})

describe('bootPayloadFor', () => {
  const cases = [
    ['claude', 'new'],
    ['claude', 'resume'],
    ['codex', 'new'],
    ['codex', 'resume']
  ] as const

  it('clears the line first and submits with CR, leaving the command untouched between', () => {
    for (const [agent, origin] of cases) {
      const payload = bootPayloadFor(agent, origin, ID)
      expect(payload.startsWith(CLEAR)).toBe(true)
      expect(payload.endsWith('\r')).toBe(true)
      expect(payload).toBe(`${CLEAR}${bootCommandFor(agent, origin, ID)}\r`)
    }
  })

  it('prevents the two-command fusion bug: the payload begins by killing the line', () => {
    // Regression guard for the observed `claude --session-id <id>claude --resume <id>` corruption,
    // where a recalled history line prefixed the boot command and claude rejected the combination.
    // The leading Ctrl-U kills anything already on the line, so it can never prefix our command.
    expect(bootPayloadFor('claude', 'resume', ID)).toBe(`\x05\x15claude --resume ${ID}\r`)
  })
})
