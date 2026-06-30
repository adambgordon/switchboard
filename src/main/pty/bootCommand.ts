import { type AgentKind } from '../../shared/types'

/**
 * The shell command to type to boot an agent. Claude resumes by id (`--resume`) or starts a fresh
 * session with a PRE-ASSIGNED id (`--session-id`). Codex resumes by id (`codex resume <id>`) but
 * mints its OWN id for a new session, so a new Codex run is a bare `codex` (its rollout id is
 * discovered afterward — see the new-session correlation in codex-integration.md).
 */
export function bootCommandFor(
  agent: AgentKind,
  origin: 'resume' | 'new',
  sessionId: string
): string {
  if (agent === 'codex') {
    return origin === 'resume' ? `codex resume ${sessionId}` : 'codex'
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
