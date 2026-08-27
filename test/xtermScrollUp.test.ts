import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  installScrollbackSafeScrollUp,
  type ScrollUpTerminal
} from '../src/renderer/lib/xtermScrollUp'

// These tests drive a REAL terminal engine rather than a fake, because what is under test is a
// disagreement between two of xterm's own scroll routines — which a fake would simply restate.
// `@xterm/headless` is the same engine as the `@xterm/xterm` the app ships, with the browser
// rendering layer removed so it runs under vitest's node environment.
//
// What this buys, and what it does not: these cases pin the behaviors they exercise. A future
// xterm change that alters something none of them touch still passes. The guards in the shim
// catch a member that has been REMOVED; only a test that exercises a behavior catches that
// behavior changing.

const ROWS = 12
const COLS = 40

function makeTerm(scrollback = 100): Terminal {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback, allowProposedApi: true })
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

/** Lines `1..n`, with NO trailing newline, so the screen fills without scrolling. */
function numberedLines(n: number): string {
  return Array.from({ length: n }, (_, i) => String(i + 1)).join('\r\n')
}

function rowText(term: Terminal, index: number): string {
  return term.buffer.active.getLine(index)?.translateToString(true) ?? ''
}

function rowRange(term: Terminal, start: number, end: number): string[] {
  const out: string[] = []
  for (let i = start; i < end; i++) out.push(rowText(term, i))
  return out
}

/** The visible screen, read relative to `baseY` so it is comparable across differing scrollback. */
function screen(term: Terminal): string[] {
  const base = term.buffer.active.baseY
  return rowRange(term, base, base + ROWS)
}

/** 12 numbered rows, then scroll the top-anchored region `1..10` up by `amount`. */
async function runTopAnchored(term: Terminal, amount = 5): Promise<void> {
  await write(term, numberedLines(ROWS))
  await write(term, `\x1b[1;10r\x1b[${amount === 1 ? '' : amount}S\x1b[r`)
}

describe('installScrollbackSafeScrollUp', () => {
  it('commits rows displaced by a top-anchored SU to scrollback', async () => {
    const term = makeTerm()
    installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
    await runTopAnchored(term, 5)

    expect(term.buffer.active.baseY).toBe(5)
    expect(rowRange(term, 0, 5)).toEqual(['1', '2', '3', '4', '5'])
  })

  it('destroys those rows without the shim installed', async () => {
    // The contrast case. Without it the test above could pass against an engine that never had
    // the defect, and would not prove the shim is doing anything.
    const term = makeTerm()
    await runTopAnchored(term, 5)

    expect(term.buffer.active.baseY).toBe(0)
    expect(rowText(term, 0)).toBe('6')
  })

  it('leaves the visible screen identical to the unfixed engine', async () => {
    const fixed = makeTerm()
    installScrollbackSafeScrollUp(fixed as unknown as ScrollUpTerminal)
    await runTopAnchored(fixed, 5)

    const unfixed = makeTerm()
    await runTopAnchored(unfixed, 5)

    expect(screen(fixed)).toEqual(screen(unfixed))
  })

  it('commits exactly the requested number of rows', async () => {
    const term = makeTerm()
    installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
    await runTopAnchored(term, 3)

    // 3, not 5 and not 1: an amount that is distinguishable from both the default and the other
    // fixture in this file, so a hardcoded count cannot satisfy every case.
    expect(term.buffer.active.baseY).toBe(3)
    expect(rowRange(term, 0, 3)).toEqual(['1', '2', '3'])
  })

  it('treats an omitted parameter as one row', async () => {
    const term = makeTerm()
    installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
    await write(term, numberedLines(ROWS))
    await write(term, '\x1b[1;10r\x1b[S\x1b[r')

    expect(term.buffer.active.baseY).toBe(1)
    expect(rowText(term, 0)).toBe('1')
  })

  it('leaves a region NOT anchored at row 1 to the built-in, which discards', async () => {
    const term = makeTerm()
    installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
    await write(term, numberedLines(ROWS))
    await write(term, '\x1b[3;10r\x1b[2S\x1b[r')

    // Nothing reaches scrollback...
    expect(term.buffer.active.baseY).toBe(0)
    // ...and an in-place rotation did happen: rows 3..10 moved up by two, so screen row 2 now
    // holds what was row 4. That rules out the sequence being swallowed and nothing occurring.
    //
    // It does NOT prove the shim declined. `BufferService.scroll()` branches on `scrollTop`
    // itself and performs the same in-place rotation when it is non-zero, so intercepting here
    // yields an identical buffer. Verified by mutation: neutering the `scrollTop` guard leaves
    // this case green. The guard is covered by the fail-closed test of the same name below, which
    // asserts the handler's return value directly — the only place that distinction is visible.
    expect(rowText(term, 2)).toBe('5')
  })

  it('declines on the alternate screen', async () => {
    const build = async (install: boolean): Promise<Terminal> => {
      const term = makeTerm()
      if (install) installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
      await write(term, '\x1b[?1049h')
      await runTopAnchored(term, 5)
      return term
    }
    const fixed = await build(true)
    const unfixed = await build(false)

    expect(fixed.buffer.active.type).toBe('alternate')
    // Compared against the unfixed engine rather than asserting `baseY === 0`: the alternate
    // buffer has no scrollback, so `baseY` is 0 either way and that assertion would hold even if
    // the shim wrongly intercepted here.
    expect(rowRange(fixed, 0, ROWS)).toEqual(rowRange(unfixed, 0, ROWS))
  })

  it('keeps a saved cursor on the same screen row across a top-anchored SU', async () => {
    const term = makeTerm()
    installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
    await write(term, numberedLines(ROWS))
    // Park the cursor on screen row 6 and save it (DECSC).
    await write(term, '\x1b[7;1H\x1b7')
    await write(term, '\x1b[1;10r\x1b[5S\x1b[r')
    await write(term, '\x1b8')

    // `savedY` is absolute (`ybase + y`) and restore recovers `savedY - ybase`, so advancing
    // `ybase` without advancing `savedY` would land the cursor 5 rows too high.
    expect(term.buffer.active.cursorY).toBe(6)
  })

  it('stops adjusting the saved cursor once scrollback is full', async () => {
    // scrollback 2 with 12 rows caps the buffer at 14 lines, so only the first two of five
    // iterations can advance `ybase`; the rest recycle. A bulk `savedY += amount` would overshoot
    // by three and restore the cursor to the wrong row.
    const term = makeTerm(2)
    installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
    await write(term, numberedLines(ROWS))
    await write(term, '\x1b[7;1H\x1b7')
    await write(term, '\x1b[1;10r\x1b[5S\x1b[r')
    await write(term, '\x1b8')

    expect(term.buffer.active.baseY).toBe(2)
    expect(term.buffer.active.cursorY).toBe(6)
  })

  it('stops intercepting once disposed', async () => {
    const term = makeTerm()
    const handle = installScrollbackSafeScrollUp(term as unknown as ScrollUpTerminal)
    handle.dispose()
    await runTopAnchored(term, 5)

    expect(term.buffer.active.baseY).toBe(0)
  })
})

// The shim declines rather than throwing when an internal it needs is absent, so a future xterm
// rename degrades to the engine's current behavior. Driven through hand-built hosts because the
// real engine cannot be made to lack these members.
describe('installScrollbackSafeScrollUp fail-closed guards', () => {
  type Overrides = {
    type?: 'normal' | 'alternate'
    scrollTop?: number
    savedY?: unknown
    eraseAttrData?: unknown
    scroll?: unknown
    /**
     * Drop an entire private container, to exercise the outer compatibility guard. Without this
     * the fake always supplies `_core`, `_bufferService` and `buffer`, so reversing that guard
     * would leave every test green.
     */
    omit?: 'core' | 'bufferService' | 'buffer'
    /** CSI parameters to dispatch with. Defaults to a single row. */
    params?: (number | number[])[]
  }

  function invokeWith(overrides: Overrides): {
    handled: boolean
    savedY: unknown
    baseY: number
  } {
    let handler: ((params: (number | number[])[]) => boolean) | undefined
    // The public buffer view. `baseY` is read from here, so the fake carries it — and carries it
    // ONLY here: `privateBuffer` deliberately has no `ybase`.
    const active = { type: overrides.type ?? 'normal', baseY: 0 }
    const privateBuffer = {
      scrollTop: overrides.scrollTop ?? 0,
      savedY: 'savedY' in overrides ? overrides.savedY : 0
    }
    const bufferService = overrides.omit === 'buffer' ? {} : { buffer: privateBuffer }
    const core = {
      // The default advances the PUBLIC base, as a committing scroll does. That is what makes a
      // revert to the private `ybase` observable: such a mutant would read `undefined` on both
      // sides of the per-iteration delta and write NaN into `savedY`, while still returning true.
      scroll:
        'scroll' in overrides
          ? overrides.scroll
          : () => {
              active.baseY += 1
            },
      _inputHandler: {
        _eraseAttrData: 'eraseAttrData' in overrides ? overrides.eraseAttrData : () => ({})
      },
      ...(overrides.omit === 'bufferService' ? {} : { _bufferService: bufferService })
    }
    const host = {
      buffer: { active },
      parser: {
        registerCsiHandler: (_id: unknown, h: (params: (number | number[])[]) => boolean) => {
          handler = h
          return { dispose: () => {} }
        }
      },
      ...(overrides.omit === 'core' ? {} : { _core: core })
    }
    installScrollbackSafeScrollUp(host as unknown as ScrollUpTerminal)
    if (!handler) throw new Error('handler was never registered')
    const handled = handler(overrides.params ?? [1])
    return { handled, savedY: privateBuffer.savedY, baseY: active.baseY }
  }

  it('intercepts and compensates the saved cursor from the PUBLIC viewport base', () => {
    const result = invokeWith({})
    expect(result.handled).toBe(true)
    expect(result.baseY).toBe(1)
    // The assertion that pins the public-`baseY` migration. Reading the private `ybase` instead
    // would leave this NaN — the fake has no such field — while `handled` and `baseY` stay correct,
    // so a return-value-only assertion cannot see that revert.
    expect(result.savedY).toBe(1)
  })

  it('compensates once per scrolled row', () => {
    const result = invokeWith({ params: [3] })
    expect(result.handled).toBe(true)
    expect(result.baseY).toBe(3)
    // 3, so a mutant that compensates a fixed single row cannot satisfy both cases.
    expect(result.savedY).toBe(3)
  })

  it('declines on the alternate screen', () => {
    expect(invokeWith({ type: 'alternate' }).handled).toBe(false)
  })

  it('declines when the region is not top-anchored', () => {
    expect(invokeWith({ scrollTop: 2 }).handled).toBe(false)
  })

  it('declines when savedY is not a number', () => {
    // Unguarded, `undefined += 1` would write NaN into the saved cursor row and corrupt a later
    // restore — worse than declining. Unlike `scrollTop`, a value comparison cannot catch this.
    expect(invokeWith({ savedY: undefined }).handled).toBe(false)
  })

  it('declines when the erase-attribute accessor is missing', () => {
    expect(invokeWith({ eraseAttrData: undefined }).handled).toBe(false)
  })

  it('declines when the committing scroll routine is missing', () => {
    expect(invokeWith({ scroll: undefined }).handled).toBe(false)
  })

  it('declines when _core is absent', () => {
    expect(invokeWith({ omit: 'core' }).handled).toBe(false)
  })

  it('declines when the buffer service is absent', () => {
    expect(invokeWith({ omit: 'bufferService' }).handled).toBe(false)
  })

  it('declines when the private buffer is absent', () => {
    expect(invokeWith({ omit: 'buffer' }).handled).toBe(false)
  })
})

// Guards the premise of every test above: they only mean something if the engine they exercise is
// the engine the app ships. npm resolves the two packages independently, so bumping one and not
// the other would leave these tests validating a version that is not in the build — passing, and
// telling us nothing.
describe('xterm version lockstep', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  type Manifest = {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  type Lockfile = { packages?: Record<string, { version?: string }> }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as Lockfile

  it('declares the same range for @xterm/xterm and @xterm/headless', () => {
    expect(pkg.devDependencies?.['@xterm/headless']).toBe(pkg.dependencies?.['@xterm/xterm'])
  })

  it('resolves both to the same version', () => {
    const shipped = lock.packages?.['node_modules/@xterm/xterm']?.version
    const tested = lock.packages?.['node_modules/@xterm/headless']?.version
    // Asserted non-empty first: two `undefined`s comparing equal would pass vacuously if either
    // entry were renamed or dropped.
    expect(shipped).toBeTruthy()
    expect(tested).toBeTruthy()
    expect(tested).toBe(shipped)
  })
})
