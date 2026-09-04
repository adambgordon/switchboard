import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { describe, expect, it } from 'vitest'
import { HANDOFF_SCROLLBACK_ROWS } from '../src/shared/terminalHistory'

const COLS = 80
const ROWS = 24

function makeTerm(): { term: Terminal; serialize: SerializeAddon } {
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 8000,
    allowProposedApi: true
  })
  const serialize = new SerializeAddon()
  term.loadAddon(serialize)
  return { term, serialize }
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function visible(term: Terminal): string[] {
  const base = term.buffer.active.baseY
  return Array.from({ length: ROWS }, (_, i) =>
    term.buffer.active.getLine(base + i)?.translateToString(true) ?? ''
  )
}

/** Snapshot a source terminal and replay it into a fresh one, as a cross-window handoff does. */
async function handOff(source: { serialize: SerializeAddon }): Promise<{
  term: Terminal
  serialize: SerializeAddon
}> {
  const snapshot = source.serialize.serialize({ scrollback: HANDOFF_SCROLLBACK_ROWS })
  const restored = makeTerm()
  await write(restored.term, snapshot)
  return restored
}

describe('serialized PTY handoff', () => {
  it('restores alternate-buffer state, modes, cursor, and visible content', async () => {
    const source = makeTerm()
    await write(
      source.term,
      '\x1b[?1049h\x1b[?2004h\x1b[2J\x1b[4;7H\x1b[31mCURRENT TUI\x1b[0m\x1b[9;13H'
    )
    const before = {
      screen: visible(source.term),
      x: source.term.buffer.active.cursorX,
      y: source.term.buffer.active.cursorY
    }

    const restored = await handOff(source)

    expect(restored.term.buffer.active.type).toBe('alternate')
    expect(restored.term.modes.bracketedPasteMode).toBe(true)
    expect(visible(restored.term)).toEqual(before.screen)
    expect(restored.term.buffer.active.cursorX).toBe(before.x)
    expect(restored.term.buffer.active.cursorY).toBe(before.y)

    source.term.dispose()
    restored.term.dispose()
  })

  it('keeps the newest bounded normal-buffer history rather than slicing VT bytes', async () => {
    const source = makeTerm()
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`).join('\r\n')
    await write(source.term, lines)
    const sourceScreen = visible(source.term)

    const restored = await handOff(source)

    expect(restored.term.buffer.active.type).toBe('normal')
    expect(restored.term.buffer.active.baseY).toBeLessThanOrEqual(HANDOFF_SCROLLBACK_ROWS)
    expect(visible(restored.term)).toEqual(sourceScreen)

    source.term.dispose()
    restored.term.dispose()
  })

  // The tests above compare the frame AT the moment of restore. That is not the same claim as
  // "the terminal keeps behaving correctly afterwards" — a restored terminal can look pixel-right
  // and still diverge on the next byte, because the snapshot carries buffers and a subset of
  // public modes, not the full parser state. The tests below feed IDENTICAL output to both sides
  // after the handoff, which is the only shape that can tell those two claims apart.
  it('continues identically when later output arrives on a plain normal buffer', async () => {
    const source = makeTerm()
    await write(source.term, 'alpha\r\nbeta\r\ngamma')

    const restored = await handOff(source)
    await write(source.term, '\r\ndelta')
    await write(restored.term, '\r\ndelta')

    expect(visible(restored.term)).toEqual(visible(source.term))
    expect(visible(restored.term).slice(0, 4)).toEqual(['alpha', 'beta', 'gamma', 'delta'])

    source.term.dispose()
    restored.term.dispose()
  })

  // The two tests below pin ACCEPTED limitations, so the gap is visible in the suite instead of
  // silently uncovered. They assert the values the current implementation really produces, not the
  // values we would prefer — if one fails, fidelity CHANGED, and the expectation (plus the
  // architecture note on terminal transfer) needs updating rather than the test deleting.
  //
  // Accepted because the exposure is narrow: a pane move re-parents the live xterm and never
  // serializes at all, so only a cross-WINDOW move takes this path, and that path ends in a
  // `PtyManager.repaint()` SIGWINCH — which a full-screen agent TUI answers by re-issuing its own
  // margins and redrawing. Carrying the state by hand would mean reaching into xterm's private
  // parser. Neither mitigation helps a saved cursor.
  it('documents a known limitation: DECSTBM scroll margins do not survive, so a region scroll diverges', async () => {
    // Margins 2..5, cursor parked ON the bottom margin, so the next linefeed MUST scroll the
    // region. Without that the cursor never reaches the boundary, lost margins change nothing, and
    // the test would pass against a correct AND a broken implementation alike.
    const setup = 'L1\r\nL2\r\nL3\r\nL4\r\nL5\x1b[2;5r\x1b[5;1H'
    const source = makeTerm()
    await write(source.term, setup)

    const restored = await handOff(source)
    await write(source.term, '\nAFTER')
    await write(restored.term, '\nAFTER')

    // The source scrolled rows 2..5 only, pushing L2 out of the region.
    expect(visible(source.term).slice(0, 6)).toEqual(['L1', 'L3', 'L4', 'L5', 'AFTER', ''])
    // The restored terminal has no region, so the whole screen scrolled and L2 survived.
    expect(visible(restored.term).slice(0, 6)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'AFTER'])

    source.term.dispose()
    restored.term.dispose()
  })

  it('documents a known limitation: the DECSC saved cursor does not survive, so DECRC lands at column 0', async () => {
    const source = makeTerm()
    await write(source.term, 'ABC\x1b[s')

    const restored = await handOff(source)
    // Pin that the handoff itself worked before blaming the saved cursor. Without this, a handoff
    // that replayed NOTHING would also land `SAVED` at column 0 of an empty row 0 and the test
    // would pass for entirely the wrong reason — verified by mutation.
    expect(visible(restored.term)[0]).toBe('ABC')

    await write(source.term, '\r\n\x1b[uSAVED')
    await write(restored.term, '\r\n\x1b[uSAVED')

    // The source restores to column 3 and overwrites from there; the restored one restores to 0.
    expect(visible(source.term)[0]).toBe('ABCSAVED')
    expect(visible(restored.term)[0]).toBe('SAVED')

    source.term.dispose()
    restored.term.dispose()
  })
})
