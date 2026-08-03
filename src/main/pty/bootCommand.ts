import { type AgentKind } from '../../shared/types'

const CODEX_REPLAY_ROWS = 2000

const CODEX_OVERRIDES = [
  `tui.terminal_resize_reflow_max_rows=${CODEX_REPLAY_ROWS}`,
  // OSC 9 carries only display text, so exclude turn-complete previews before the prefix-only
  // input scanner sees them.
  'tui.notifications=["approval-requested","plan-mode-prompt"]',
  'tui.notification_method="osc9"',
  'tui.notification_condition="always"'
]

/**
 * The shell command to type to boot an agent. Claude resumes by id (`--resume`) or starts a fresh
 * session with a PRE-ASSIGNED id (`--session-id`). Codex resumes by id (`codex resume <id>`) but
 * mints its OWN id for a new session. Codex rebuilds terminal scrollback from its source-backed
 * transcript after a resize; cap that replay explicitly because its automatic fallback for an
 * unidentified xterm host keeps only 1,000 rows.
 */
export function bootCommandFor(
  agent: AgentKind,
  origin: 'resume' | 'new',
  sessionId: string
): string {
  if (agent === 'codex') {
    const overrides = CODEX_OVERRIDES.map((value) => `-c '${value}'`).join(' ')
    const command = `codex ${overrides}`
    return origin === 'resume' ? `${command} resume ${sessionId}` : command
  }
  return origin === 'resume' ? `claude --resume ${sessionId}` : `claude --session-id ${sessionId}`
}

/**
 * Control bytes that clear the shell's input line before we type the boot command: Ctrl-E
 * (end-of-line) then Ctrl-U (kill-line). Together they wipe any pre-existing content on the line —
 * regardless of cursor position — under the standard zsh/bash emacs keymaps, and are no-ops on an
 * empty prompt. Without this, stray content already on the prompt fuses onto our command: e.g. a
 * recalled-history `claude --session-id <id>` (from an up-arrow, or a keystroke typed in the brief
 * window before boot) with `claude --resume <id>` typed onto it, which claude rejects with
 * "--session-id can only be used with --continue or --resume if --fork-session is also specified."
 * Clearing first makes the boot command immune to whatever is on the line, whatever put it there.
 */
const CLEAR_LINE = '\x05\x15'

/**
 * The exact bytes written to the PTY to boot an agent: clear the line, type the command, submit with
 * `\r`. Kept here — separate from the node-pty-bound PtyManager — so it stays a pure function and is
 * unit-testable without spawning a real PTY.
 */
export function bootPayloadFor(
  agent: AgentKind,
  origin: 'resume' | 'new',
  sessionId: string
): string {
  return `${CLEAR_LINE}${bootCommandFor(agent, origin, sessionId)}\r`
}
