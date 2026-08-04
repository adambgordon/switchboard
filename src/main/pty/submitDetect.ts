/**
 * Decide whether a renderer input payload contains a real prompt SUBMIT — the Enter keypress that
 * makes an agent start a turn. Pure, so the escape-sequence walk can be tested exhaustively without
 * a PTY.
 *
 * Why this is fussier than `data.includes('\r')`: `TerminalView` forwards raw `term.onData` straight
 * through, and that transport carries more than keystrokes. xterm normalizes every newline in a
 * multi-line paste to `\r` and wraps the text in bracketed-paste markers, so a user still COMPOSING a
 * pasted prompt would otherwise look like they had submitted it. For new-Codex binding that isn't
 * cosmetic: a premature stamp lets one terminal claim the rollout another terminal's real Enter
 * created (see matchProvisionalCodex).
 *
 * So: track bracketed-paste state across payloads (a large paste can arrive in several chunks) and
 * count only a DISCRETE Enter outside any paste. A typed Enter is its own `onData` payload — xterm
 * fires per keystroke and does not batch typed characters — so requiring the payload to be exactly a
 * newline is the tight, correct rule, not an approximation. Anything ambiguous fails CLOSED (no
 * stamp): an unbound PTY is a terminal that works but isn't linked to its row, which is a mild
 * degradation, whereas a wrong stamp wires a row to another conversation entirely.
 */

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export interface SubmitScan {
  /** A discrete Enter, pressed outside any bracketed paste. */
  submitted: boolean
  /** Bracketed-paste state to carry into the next payload. */
  inPaste: boolean
}

/** Is this whole out-of-paste segment nothing but a newline — i.e. the Enter key alone? */
function isBareSubmit(segment: string): boolean {
  return segment === '\r' || segment === '\n' || segment === '\r\n'
}

/**
 * Walk `data`, skipping bracketed-paste spans, and report whether a discrete Enter occurred outside
 * them. `inPaste` is the state returned by the previous call for the same PTY (false to start).
 */
export function scanForSubmit(data: string, inPaste: boolean): SubmitScan {
  let rest = data
  let insidePaste = inPaste
  let submitted = false

  while (rest.length > 0) {
    if (insidePaste) {
      const end = rest.indexOf(PASTE_END)
      // No terminator yet: the paste continues into a later payload.
      if (end === -1) return { submitted, inPaste: true }
      insidePaste = false
      rest = rest.slice(end + PASTE_END.length)
      continue
    }
    const start = rest.indexOf(PASTE_START)
    const segment = start === -1 ? rest : rest.slice(0, start)
    if (isBareSubmit(segment)) submitted = true
    if (start === -1) break
    insidePaste = true
    rest = rest.slice(start + PASTE_START.length)
  }

  return { submitted, inPaste: insidePaste }
}
