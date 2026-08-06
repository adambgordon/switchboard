/**
 * Which Switchboard-owned Claude terminals have launched a background agent.
 *
 * Claude records this on the session in its own session registry as `parkedJobId`. Read it for EXACTLY
 * what it says and nothing more:
 *
 * - It is written when the session **spawns** a background agent.
 * - It is NOT cleared when the session leaves Agent View.
 * - It is NOT cleared when the agent finishes.
 *
 * So it cannot indicate Agent View, and treating it that way misreports every ordinary conversation
 * that happens to launch an agent — and, because it never clears, permanently.
 *
 * Agent View IS separately detectable, just not from here: Claude writes
 * `~/.claude/daemon/attach-journal/<gestureId>.json` on attach and unlinks it on detach, carrying
 * `pid`, `procStart`, and `surface` (`"fleet"` = Agent View). No debug flag, no banner — but it
 * records no job identifier, so it can say a terminal is in Agent View and never which agent is on
 * screen. The `--debug=fv-attach` log does carry the job id, and is rejected because that flag prints
 * a debug banner into every terminal it is passed to. Both are written up in the work-stream findings;
 * nothing here needs either.
 *
 * What this IS good for: a terminal whose own transcript is empty because its work went into a
 * background agent. That row would otherwise read "New conversation · 0 msg" while the user is busy
 * in it. Pairing this marker with "has no indexed conversation" identifies exactly that case, and the
 * renderer re-asks the question every pass, so the row corrects itself the moment the session writes
 * a transcript of its own.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, watch as watchFile } from 'node:fs'
import type { FSWatcher as NodeFsWatcher } from 'node:fs'
import { readBgJobName } from '../sessions/claudeJobs'

const SHORT_ID = /^[a-f0-9]{6,}$/i
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const REGISTRY_POLL_MS = 250
/**
 * How long a marker must have been observed continuously before it is reported.
 *
 * A session that launches an agent as its very first action writes the marker and its own first
 * transcript line at almost the same moment, but the two reach Switchboard by different paths: the
 * marker through this poll, the transcript through the watcher's 200 ms write-stability window plus
 * the indexer's 400 ms debounce. Report the marker first and the row shows the agent's name for the
 * gap, then corrects to an ordinary conversation — the flash this exists to prevent.
 *
 * It is a WINDOW, not a count of observations. Counting was the first attempt and does not work:
 * `refresh()` runs on registry-directory events AND on every `register()`, so an unrelated Claude
 * terminal opening can supply a second observation in the same millisecond as the first, confirming
 * nothing. Elapsed time is the only thing the index path can be outrun by.
 *
 * The window clears the ~600 ms index path with margin, and `REGISTRY_POLL_MS` schedules the recheck,
 * so this needs no timer of its own. The cost is that a genuine parked-only row arrives about a second
 * late — nothing against the row it replaces, which otherwise persists for the life of the terminal.
 */
export const CONFIRM_AFTER_MS = 900

export interface ParkedJob {
  shortId: string
  /** The agent's own name, so the row can say what is running. Empty when the job has none. */
  name: string
}

export interface ParkedJobRecord {
  sessionId: string
  pid: number
  shortId: string
}

/** Read a live-session record, returning its parked-agent marker only when every field checks out. */
export function parkedJobFromRegistry(text: string): ParkedJobRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return value.kind === 'interactive' &&
      typeof value.sessionId === 'string' &&
      SESSION_ID.test(value.sessionId) &&
      typeof value.parkedJobId === 'string' &&
      SHORT_ID.test(value.parkedJobId) &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0
      ? { sessionId: value.sessionId, pid: value.pid, shortId: value.parkedJobId }
      : null
  } catch {
    return null
  }
}

export interface ClaudeParkedJobMonitorOptions {
  sessionsRoot?: string
  isProcessAlive?: (pid: number) => boolean
  resolveJobName?: (shortId: string) => string
  /** Injectable clock — the confirmation window is the behavior, so tests must be able to drive it. */
  now?: () => number
  onChange: (ptyId: string, parked: ParkedJob | null) => void
}

interface Controller {
  sessionId: string
  reported: ParkedJob | null
  pendingShortId: string | null
  /** When `pendingShortId` was first observed; the marker is reported CONFIRM_AFTER_MS later. */
  pendingSince: number
}

/**
 * Watches Claude's private session registry for the parked-agent marker on Switchboard-owned Claude
 * PTYs. Consumers see only a per-PTY parked-job value; registry records, pids, and confirmation
 * policy stay behind this boundary. Watching runs only while Claude PTYs exist.
 */
export class ClaudeParkedJobMonitor {
  private readonly sessionsRoot: string
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly resolveJobName: (shortId: string) => string
  private readonly now: () => number
  private readonly onChange: (ptyId: string, parked: ParkedJob | null) => void
  private readonly controllers = new Map<string, Controller>()
  private watcher: NodeFsWatcher | null = null
  private poll: ReturnType<typeof setInterval> | null = null

  constructor(opts: ClaudeParkedJobMonitorOptions) {
    this.sessionsRoot = opts.sessionsRoot ?? join(homedir(), '.claude', 'sessions')
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive
    this.resolveJobName = opts.resolveJobName ?? ((shortId) => readBgJobName(shortId))
    this.now = opts.now ?? (() => Date.now())
    this.onChange = opts.onChange
  }

  register(ptyId: string, sessionId: string): void {
    this.controllers.set(ptyId, {
      sessionId,
      reported: null,
      pendingShortId: null,
      pendingSince: 0
    })
    this.startWatching()
    this.refresh()
  }

  unregister(ptyId: string): void {
    this.controllers.delete(ptyId)
    if (this.controllers.size === 0) this.stopWatching()
  }

  dispose(): void {
    this.controllers.clear()
    this.stopWatching()
  }

  private startWatching(): void {
    if (this.poll) return
    try {
      this.watcher = watchFile(this.sessionsRoot, () => this.refresh())
      this.watcher.on('error', () => {
        try {
          this.watcher?.close()
        } catch {
          /* already closed */
        }
        this.watcher = null
      })
    } catch {
      /* the registry directory may not exist yet; the poll below is the reliable path */
    }
    this.poll = setInterval(() => this.refresh(), REGISTRY_POLL_MS)
    this.poll.unref()
  }

  private stopWatching(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    try {
      this.watcher?.close()
    } catch {
      /* app-owned watcher cleanup is best-effort */
    }
    this.watcher = null
  }

  private refresh(): void {
    const bySession = new Map<string, string>()
    try {
      for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        try {
          const record = parkedJobFromRegistry(
            readFileSync(join(this.sessionsRoot, entry.name), 'utf8')
          )
          // Claude leaves the record behind when a session dies, so a resumed conversation would
          // otherwise inherit the dead process's marker.
          if (record && this.isProcessAlive(record.pid)) {
            bySession.set(record.sessionId, record.shortId)
          }
        } catch {
          /* one unreadable record must not hide the rest */
        }
      }
    } catch {
      // The registry is absent entirely — hold current state rather than reporting every PTY as
      // having no parked agent.
      return
    }

    const now = this.now()
    for (const [ptyId, controller] of this.controllers) {
      const shortId = bySession.get(controller.sessionId) ?? null
      if (shortId === null) {
        controller.pendingShortId = null
        controller.pendingSince = 0
        if (controller.reported) {
          controller.reported = null
          this.onChange(ptyId, null)
        }
        continue
      }
      if (controller.reported?.shortId === shortId) {
        // Already reported AND named — nothing left to resolve.
        if (controller.reported.name) continue
        // Confirmed, but Claude had not written the agent's name yet. Its `nameSource` is `auto`, so
        // the name is generated after the fact and the first read is routinely empty; without this
        // the row would keep its fallback title for the life of the terminal.
        const laterName = this.resolveJobName(shortId)
        if (!laterName) continue
        controller.reported = { shortId, name: laterName }
        this.onChange(ptyId, controller.reported)
        continue
      }
      // A different marker restarts the window — the new one has had no time to be contradicted.
      if (controller.pendingShortId !== shortId) {
        controller.pendingShortId = shortId
        controller.pendingSince = now
      }
      if (now - controller.pendingSince < CONFIRM_AFTER_MS) continue
      const parked: ParkedJob = { shortId, name: this.resolveJobName(shortId) }
      controller.reported = parked
      this.onChange(ptyId, parked)
    }
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
