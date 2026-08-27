/**
 * Make a top-anchored SU (`CSI Ps S`) send its displaced rows to scrollback.
 *
 * xterm.js has TWO routines that shift lines up, and they disagree about what happens to the
 * row that leaves the top:
 *
 *   - `BufferService.scroll()` — the linefeed path. With `scrollTop === 0` it inserts the new
 *     blank line below the bottom margin and advances `ybase`, so the departing row becomes
 *     scrollback. This is what a TUI committing finished output through `\n` relies on.
 *   - `InputHandler.scrollUp()` — the `CSI Ps S` path. It splices the top row out and never
 *     advances `ybase`, so the row is DESTROYED even when the region is anchored at row 1 and
 *     the row should have been kept. xterm.js carries a standing `FIXME` acknowledging this.
 *
 * A TUI that renders an inline viewport above a composer uses a top-anchored scroll region to
 * make room when that bottom region grows, and assumes the terminal preserved what scrolled off
 * — so it never repaints those rows. On xterm.js they are simply gone, leaving permanent holes
 * in the transcript that only a full redraw (resize, or restarting the program) can heal.
 *
 * This installs a `CSI S` handler that runs BEFORE xterm's built-in and, only for the case the
 * built-in gets wrong, performs the scroll through the committing path instead. Returning `true`
 * consumes the sequence so the built-in never runs; returning `false` falls through to it
 * unchanged.
 *
 * Reached through private xterm internals (`_core`), guarded per member. Note what the guards do
 * and do not buy: they detect a member that has been REMOVED or renamed, in which case we decline
 * and the terminal keeps xterm's current behavior. They cannot detect a member that still exists
 * and has changed meaning. Only the tests that exercise a given behavior cover that, and only for
 * the behaviors they actually exercise.
 *
 * REMOVAL CONDITION: xtermjs/xterm.js#6011 implements this same delegation upstream (including the
 * saved-cursor adjustment below). Once a version carrying it is adopted, this shim is redundant and
 * should be deleted — and re-read first, since that change touches the very routine called here.
 */

/**
 * The PRIVATE buffer fields this shim touches. `savedY` is absolute (see the handler).
 *
 * `ybase` is deliberately NOT here: the viewport base is read through the public
 * `buffer.active.baseY`, which returns that same field. Reading it publicly needs no guard and
 * keeps one less undocumented member in play — and it matters that the two reads around the
 * scroll below cannot go `undefined`, because they are subtracted from each other and the result
 * is added to `savedY`, so a renamed member would silently write `NaN` into the saved cursor.
 */
interface ScrollUpBuffer {
  scrollTop: number
  savedY: number
}

interface ScrollUpCore {
  scroll?: (eraseAttr: unknown, isWrapped?: boolean) => void
  _bufferService?: { buffer?: ScrollUpBuffer }
  _inputHandler?: { _eraseAttrData?: () => unknown }
}

/**
 * Structural view of a terminal, rather than importing `Terminal` from `@xterm/xterm`: that
 * package's typings reference DOM types, which do not compile under the node tsconfig the tests
 * use. Being structural also lets the tests drive `@xterm/headless` and hand-built fakes.
 */
export interface ScrollUpTerminal {
  buffer: { active: { type: 'normal' | 'alternate'; baseY: number } }
  parser: {
    registerCsiHandler(
      id: { final: string },
      handler: (params: (number | number[])[]) => boolean
    ): { dispose(): void }
  }
  _core?: ScrollUpCore
}

export function installScrollbackSafeScrollUp(term: ScrollUpTerminal): { dispose(): void } {
  return term.parser.registerCsiHandler({ final: 'S' }, (params) => {
    // Scrollback exists only on the normal buffer. On the alternate screen there is nowhere for a
    // displaced row to go, so the built-in's in-place rotation is already correct.
    if (term.buffer.active.type !== 'normal') return false

    const core = term._core
    const buffer = core?._bufferService?.buffer
    // `!buffer` is the load-bearing half: without it the reads below throw a TypeError from inside
    // the parser rather than declining. `!core` is redundant behaviorally — `buffer` is reached
    // through `core` by optional chaining, so a missing `core` already yields a missing `buffer` —
    // and is kept for the type narrowing the calls further down need.
    if (!core || !buffer) return false

    // Only a region anchored at row 1 sends rows to scrollback. With a top margin below row 1 the
    // rows are genuinely discarded and the built-in is correct, so leave it alone.
    //
    // This check also fails closed for free: were `scrollTop` renamed it would read `undefined`,
    // and `undefined === 0` is false, so we would decline. The `savedY` write below has no such
    // accidental protection, which is why it needs an explicit guard of its own.
    //
    // Note this guard expresses intent and keeps parity with the upstream change; it is not the
    // only thing standing between us and a corrupt buffer. `BufferService.scroll()` branches on
    // `scrollTop` too and rotates in place when it is non-zero, so intercepting a region below
    // row 1 would produce the same buffer anyway. Keep the guard regardless: relying on that
    // internal branch would make this shim depend on a second undocumented behavior.
    if (buffer.scrollTop !== 0) return false
    if (typeof buffer.savedY !== 'number') return false

    const eraseAttrData = core._inputHandler?._eraseAttrData
    if (typeof eraseAttrData !== 'function') return false
    const scroll = core.scroll
    if (typeof scroll !== 'function') return false

    // Every guard is pre-flight, deliberately: bailing part-way through the loop below would leave
    // a half-applied scroll that neither path can reconcile.
    const amount = params[0]
    const count = typeof amount === 'number' && amount > 0 ? amount : 1

    for (let i = 0; i < count; i++) {
      // `savedY` (DECSC) is stored ABSOLUTE — `ybase + y` — and `restoreCursor` recovers the row as
      // `savedY - ybase`. A saved cursor stays anchored to the same SCREEN row across a scroll, so
      // advancing `ybase` without advancing `savedY` would restore the cursor that many rows too
      // high. The built-in never moved `ybase`, so this is only needed on the path taken here.
      //
      // The delta is read per iteration, not applied once as `+= count`: `scroll()` stops advancing
      // `ybase` once scrollback is full (it recycles the oldest line instead), and a bulk adjustment
      // would overshoot by however many iterations ran at the cap.
      //
      // Read via the PUBLIC `baseY` (same field as `ybase`) so neither side of this subtraction can
      // become `undefined` and poison `savedY` with `NaN`.
      const before = term.buffer.active.baseY
      scroll.call(core, eraseAttrData.call(core._inputHandler))
      buffer.savedY += term.buffer.active.baseY - before
    }

    return true
  })
}
