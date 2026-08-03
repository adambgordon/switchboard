const OSC9_START = '\x1b]9;'
const BEL = '\x07'
const ST = '\x1b\\'
const MAX_PARTIAL_SEQUENCE = 4096

const INPUT_NOTIFICATION_PREFIXES = [
  'Plan mode prompt:',
  'Approval requested:',
  'Codex wants to edit ',
  'Approval requested by '
]

function trailingStartPrefix(value: string): string {
  const maxLength = Math.min(value.length, OSC9_START.length - 1)
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = value.slice(-length)
    if (OSC9_START.startsWith(suffix)) return suffix
  }
  return ''
}

function terminatorAt(value: string, from: number): { index: number; length: number } | null {
  const bel = value.indexOf(BEL, from)
  const st = value.indexOf(ST, from)
  if (bel < 0 && st < 0) return null
  if (bel >= 0 && (st < 0 || bel < st)) return { index: bel, length: BEL.length }
  return { index: st, length: ST.length }
}

function isInputNotification(message: string): boolean {
  return INPUT_NOTIFICATION_PREFIXES.some((prefix) => message.startsWith(prefix))
}

/**
 * Streaming scanner for Codex's explicit OSC 9 desktop notifications. Codex wraps the same OSC 9
 * sequence in `ESC Ptmux; ... ESC \\` under tmux; scanning for the inner OSC start handles both
 * forms without interpreting any visible terminal text. Input is never rewritten or consumed.
 */
export class CodexInputNotificationScanner {
  private partial = ''

  push(chunk: string): boolean {
    const value = this.partial + chunk
    this.partial = ''
    let offset = 0
    let detected = false

    while (offset < value.length) {
      const start = value.indexOf(OSC9_START, offset)
      if (start < 0) {
        this.partial = trailingStartPrefix(value.slice(offset))
        break
      }

      const payloadStart = start + OSC9_START.length
      const terminator = terminatorAt(value, payloadStart)
      if (!terminator) {
        const candidate = value.slice(start)
        if (candidate.length <= MAX_PARTIAL_SEQUENCE) {
          this.partial = candidate
        } else {
          const nestedStart = value.lastIndexOf(OSC9_START)
          if (nestedStart > start) {
            offset = nestedStart
            continue
          }
          this.partial = trailingStartPrefix(candidate)
        }
        break
      }

      // A new OSC 9 start before the terminator means the earlier sequence was malformed. Restart
      // there instead of letting the later sequence's terminator complete the malformed payload.
      const nestedStart = value.indexOf(OSC9_START, payloadStart)
      if (nestedStart >= 0 && nestedStart < terminator.index) {
        offset = nestedStart
        continue
      }

      const message = value.slice(payloadStart, terminator.index)
      if (message.length <= MAX_PARTIAL_SEQUENCE && isInputNotification(message)) {
        detected = true
      }
      offset = terminator.index + terminator.length
    }

    return detected
  }
}
