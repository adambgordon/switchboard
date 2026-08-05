/**
 * Reading Claude Code's background-job state.
 *
 * A background job does not run under a Switchboard PTY: Claude Code forks the conversation into a
 * new `sessionKind:"bg"` transcript and hands it to its own daemon, which outlives whatever launched
 * it. The daemon records each job at `~/.claude/jobs/<short>/state.json`.
 *
 * Only the job's NAME is read. Its lifecycle state is deliberately not surfaced — see the note on
 * background liveness dots in the work-stream findings: a dot on a row the user cannot type into
 * reports on a daemon rather than on a conversation, and the resting states in particular read as
 * false liveness. A job parked on a question stays "running" indefinitely, so such a row would sit
 * lit for days.
 *
 * Claude-only: Codex has no background-agent concept, so there is no Codex counterpart.
 *
 * Pure Node — no Electron, no DOM — so it is directly unit-testable. A single small synchronous read.
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Job folder names are short hex ids (the first segment of the sessionId). */
const SHORT_ID = /^[a-f0-9]{6,}$/i

/** Claude Code's background-job root. */
export function defaultClaudeJobsRoot(): string {
  return path.join(os.homedir(), '.claude', 'jobs')
}

/**
 * A background agent's own name, whatever its lifecycle state. Used to label a terminal whose work
 * went into that agent instead of into its own transcript, so the row can say what is running rather
 * than only that something is. Empty when the job has no name yet or cannot be read — callers fall
 * back to the conversation's own title.
 */
export function readBgJobName(shortId: string, root: string = defaultClaudeJobsRoot()): string {
  if (!SHORT_ID.test(shortId)) return ''
  try {
    const raw = JSON.parse(
      readFileSync(path.join(root, shortId, 'state.json'), 'utf8')
    ) as Record<string, unknown>
    return typeof raw.name === 'string' ? raw.name.trim() : ''
  } catch {
    return ''
  }
}
