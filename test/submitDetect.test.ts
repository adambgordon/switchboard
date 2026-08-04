import { describe, expect, it } from 'vitest'
import { scanForSubmit } from '../src/main/pty/submitDetect'

const START = '\x1b[200~'
const END = '\x1b[201~'

describe('scanForSubmit', () => {
  it('counts a discrete Enter', () => {
    expect(scanForSubmit('\r', false)).toEqual({ submitted: true, inPaste: false })
  })

  it('accepts the \\n and \\r\\n newline spellings', () => {
    expect(scanForSubmit('\n', false).submitted).toBe(true)
    expect(scanForSubmit('\r\n', false).submitted).toBe(true)
  })

  it('ignores ordinary typing', () => {
    expect(scanForSubmit('a', false)).toEqual({ submitted: false, inPaste: false })
    expect(scanForSubmit('some prompt text', false).submitted).toBe(false)
  })

  it('ignores an empty payload without disturbing paste state', () => {
    expect(scanForSubmit('', false)).toEqual({ submitted: false, inPaste: false })
    expect(scanForSubmit('', true)).toEqual({ submitted: false, inPaste: true })
  })

  it('does not count newlines inside a bracketed paste', () => {
    expect(scanForSubmit(`${START}one\rtwo\rthree${END}`, false)).toEqual({
      submitted: false,
      inPaste: false
    })
  })

  it('does not count a payload that is only a paste-wrapped newline', () => {
    expect(scanForSubmit(`${START}\r${END}`, false).submitted).toBe(false)
  })

  it('carries paste state across chunks and stays closed until the terminator', () => {
    const a = scanForSubmit(`${START}one`, false)
    expect(a).toEqual({ submitted: false, inPaste: true })
    const b = scanForSubmit('\rtwo', a.inPaste)
    expect(b).toEqual({ submitted: false, inPaste: true })
    const c = scanForSubmit(END, b.inPaste)
    expect(c).toEqual({ submitted: false, inPaste: false })
  })

  it('counts an Enter that follows a paste terminator in the same payload', () => {
    expect(scanForSubmit(`${START}text${END}\r`, false)).toEqual({
      submitted: true,
      inPaste: false
    })
  })

  it('counts an Enter that arrives before a paste starts', () => {
    expect(scanForSubmit(`\r${START}text`, false)).toEqual({ submitted: true, inPaste: true })
  })

  it('resumes counting after a paste closes in an earlier chunk', () => {
    const open = scanForSubmit(`${START}text`, false)
    const close = scanForSubmit(END, open.inPaste)
    expect(scanForSubmit('\r', close.inPaste).submitted).toBe(true)
  })

  it('does not count a newline batched onto other characters (fails closed)', () => {
    // xterm fires onData per keystroke, so this shape doesn't occur for typed input; if it ever did
    // (an unbracketed multi-line paste), staying closed leaves the PTY unbound rather than letting it
    // claim another terminal's rollout.
    expect(scanForSubmit('go\r', false).submitted).toBe(false)
  })

  it('handles the empty bracketed paste used for Claude image input', () => {
    expect(scanForSubmit(`${START}${END}`, false)).toEqual({ submitted: false, inPaste: false })
  })
})
