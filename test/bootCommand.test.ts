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
  it('claude enables only the per-PTY Agent View debug category', () => {
    expect(bootCommandFor('claude', 'resume', ID, '/tmp/Switchboard logs/pty.log')).toBe(
      `claude --debug=fv-attach --debug-file '/tmp/Switchboard logs/pty.log' --resume ${ID}`
    )
  })
  it('shell-quotes apostrophes in the private debug-file path', () => {
    expect(bootCommandFor('claude', 'new', ID, "/tmp/Adam's logs/pty.log")).toBe(
      `claude --debug=fv-attach --debug-file '/tmp/Adam'\\''s logs/pty.log' --session-id ${ID}`
    )
  })
  it('codex new caps terminal history replay without assigning an id', () => {
    expect(bootCommandFor('codex', 'new', ID)).toBe(
      'codex -c tui.terminal_resize_reflow_max_rows=2000'
    )
  })
  it('codex resume caps terminal history replay', () => {
    expect(bootCommandFor('codex', 'resume', ID)).toBe(
      `codex -c tui.terminal_resize_reflow_max_rows=2000 resume ${ID}`
    )
  })
  it('never adds Claude private flags to Codex', () => {
    expect(bootCommandFor('codex', 'new', ID, '/tmp/ignored.log')).toBe(
      'codex -c tui.terminal_resize_reflow_max_rows=2000'
    )
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

  it('includes the private debug flags in the exact submitted Claude payload', () => {
    expect(bootPayloadFor('claude', 'resume', ID, '/tmp/pty.log')).toBe(
      `${CLEAR}claude --debug=fv-attach --debug-file '/tmp/pty.log' --resume ${ID}\r`
    )
  })
})
