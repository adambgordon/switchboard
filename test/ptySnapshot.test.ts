import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { describe, expect, it } from 'vitest'

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

    const snapshot = source.serialize.serialize({ scrollback: 2000 })
    const restored = makeTerm()
    await write(restored.term, snapshot)

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

    const snapshot = source.serialize.serialize({ scrollback: 2000 })
    const restored = makeTerm()
    await write(restored.term, snapshot)

    expect(restored.term.buffer.active.type).toBe('normal')
    expect(restored.term.buffer.active.baseY).toBeLessThanOrEqual(2000)
    expect(visible(restored.term)).toEqual(sourceScreen)

    source.term.dispose()
    restored.term.dispose()
  })
})
