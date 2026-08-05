/**
 * Reading Claude Code's BACKGROUND job state.
 *
 * A background job does not run under a Switchboard PTY: Claude Code forks the conversation into a
 * new `sessionKind:"bg"` transcript and hands it to its own daemon, which outlives whatever launched
 * it. So a bg conversation is a normal row in the index with no live process behind it — and the
 * transcript alone cannot say whether it is still working or finished months ago.
 *
 * The daemon does say, on disk: `~/.claude/jobs/<short>/state.json` carries the job's lifecycle
 * state. `claude agents --json` is simply reading these same files, so reading them directly costs
 * nothing and rides the file watcher, where shelling out would cost ~500ms per call through the
 * login shell — far too much for the index path.
 *
 * Claude-only: Codex has no background-agent concept, so there is no Codex counterpart.
 *
 * Pure Node — no Electron, no DOM — so it is directly unit-testable. Synchronous reads (a handful of
 * ~1.5KB files). Every failure degrades to "not running"; reading job state must never crash the
 * index.
 */

import { readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The lifecycle states that mean the job is finished. The live ones are `working` and `blocked`, but
 * this is deliberately the terminal set: a state string a future Claude adds would then read as
 * running rather than as finished, and wrongly hiding live work costs more than leaving a stale dot.
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['done', 'failed', 'stopped'])

/** Job folder names are short hex ids (the first segment of the sessionId). Anything else in the
 *  jobs root — `pins.json`, `.DS_Store`, a `.draft-*` scratch file — is not a job. */
const SHORT_ID = /^[a-f0-9]{6,}$/i

export interface RunningBgJob {
  shortId: string
  sessionId: string
  /** ms epoch the daemon created the job — the nearest thing it has to a process start time. */
  startedAt: number | null
}

/** Claude Code's background-job root. */
export function defaultClaudeJobsRoot(): string {
  return path.join(os.homedir(), '.claude', 'jobs')
}

/**
 * Every background job the daemon is currently running.
 *
 * **A folder with no readable `state.json` is NOT a job** and is skipped — that file is what makes a
 * job real, and treating its absence as "still starting up" surfaces months-old abandoned leftovers
 * as permanent phantom rows. The genuine mid-setup window is negligible: a bg transcript isn't
 * written until the first turn, so there is no row to decorate yet.
 *
 * Fail-open survives only for a state file that EXISTS but carries a state string this version does
 * not recognize: the daemon is demonstrably tracking that job, so assume it is running rather than
 * silently calling live work finished.
 */
export function readRunningBgJobs(root: string = defaultClaudeJobsRoot()): RunningBgJob[] {
  let folders: string[]
  try {
    folders = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SHORT_ID.test(d.name))
      .map((d) => d.name)
  } catch {
    return []
  }

  const jobs: RunningBgJob[] = []
  for (const shortId of folders) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path.join(root, shortId, 'state.json'), 'utf8'))
    } catch {
      continue
    }
    const o = (raw ?? {}) as Record<string, unknown>
    // Only a state this version KNOWS to be terminal rules a job out. A running state or an
    // unrecognized one both fall through as running.
    const state = typeof o.state === 'string' ? o.state : ''
    if (TERMINAL_STATES.has(state)) continue
    const createdAt = typeof o.createdAt === 'string' ? Date.parse(o.createdAt) : NaN
    jobs.push({
      shortId,
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : '',
      startedAt: Number.isFinite(createdAt) ? createdAt : null
    })
  }
  return jobs
}

/**
 * A background agent's own name, whatever its lifecycle state. Used to label a terminal whose work
 * went into that agent instead of into its own transcript, so the row can say what is running rather
 * than just that something is.
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

/**
 * The running job driving this conversation, if any.
 *
 * Matches on the full `sessionId` from state.json, falling back to the folder's short id as a prefix
 * (which is how the daemon derives it) for the rare state file that omits the id.
 */
export function runningBgJobFor(
  jobs: readonly RunningBgJob[],
  sessionId: string
): RunningBgJob | null {
  if (!sessionId) return null
  return (
    jobs.find((j) => j.sessionId && j.sessionId === sessionId) ??
    jobs.find((j) => !j.sessionId && sessionId.startsWith(j.shortId)) ??
    null
  )
}
