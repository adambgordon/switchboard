/**
 * What Claude's own live-session registry says about Switchboard-owned Claude terminals: which have
 * launched a background agent, and which are busy.
 *
 * The busy/idle half is the only first-party activity signal either agent publishes, and it reports
 * something the transcript cannot. Anthropic documents that "subagents run in the same process as
 * the parent session", so killing a terminal mid-subagent destroys that work — while the parent's
 * own transcript may be written nowhere for the subagent's whole duration, leaving the session
 * looking idle. The registry is written by the parent about itself, so it stays correct regardless.
 *
 * Note the two halves say almost opposite things, and only one is a reason to protect a terminal.
 * BACKGROUND (Agent View) sessions run under a separate supervisor and survive their terminal
 * closing — Anthropic: "Background sessions don't need any terminal open to keep working" — so the
 * parked marker below is NOT evidence that anything would be lost. Which is just as well, given it
 * never clears.
 *
 * The background-agent half:
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
 * a debug banner into every terminal it is passed to. Neither signal is needed to identify a terminal
 * with a background job and no indexed conversation.
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
import type { ClaudeSessionStatus } from '../../shared/types'
import { readBgJobName } from '../sessions/claudeJobs'

const SHORT_ID = /^[a-f0-9]{6,}$/i
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
/**
 * Backstop interval for the registry read — NOT the path that makes it feel responsive.
 *
 * The directory watch delivers a change in ~12 ms (measured; macOS FSEvents coalesces at ~10 ms and
 * that floor, not this interval, is the latency the user sees). This exists for when the watch is
 * unavailable or has failed, so the signal degrades to slower rather than to absent. Every pass is
 * SYNCHRONOUS on the main process's event loop — the same loop pumping terminal bytes — so it is
 * kept well clear of the poll rates that would start competing with keystroke echo: one pass
 * measured 0.1 ms against two records and projects to ~1 ms against twenty.
 */
const REGISTRY_POLL_MS = 150
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

/**
 * Read a live-session record's own account of what it is doing, or null when the record cannot
 * support the claim.
 *
 * Separate from {@link parkedJobFromRegistry} and not a superset of it: that one requires a
 * `parkedJobId`, which most records do not have, so the two accept different sets of records out of
 * the same file. An unrecognised `status` is rejected rather than mapped to a default — treating an
 * unknown value as `busy` would make a session unreclaimable for as long as its process lived.
 */
export function sessionStatusFromRegistry(text: string): SessionStatusRecord | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return value.kind === 'interactive' &&
      typeof value.sessionId === 'string' &&
      SESSION_ID.test(value.sessionId) &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      (value.status === 'busy' || value.status === 'idle')
      ? { sessionId: value.sessionId, pid: value.pid, status: value.status }
      : null
  } catch {
    return null
  }
}

export interface SessionStatusRecord {
  sessionId: string
  pid: number
  status: ClaudeSessionStatus
}

export interface ClaudeParkedJobMonitorOptions {
  sessionsRoot?: string
  isProcessAlive?: (pid: number) => boolean
  resolveJobName?: (shortId: string) => string
  /** Injectable clock — the confirmation window is the behavior, so tests must be able to drive it. */
  now?: () => number
  onChange: (ptyId: string, parked: ParkedJob | null) => void
  /**
   * Claude's own busy/idle for this PTY's session, or null once no usable record backs it.
   *
   * Reported with NO confirmation window, unlike the parked marker. That window exists to stop a row
   * TITLE flashing while two slower paths race; this value has no such race and a 900 ms delay on it
   * would be sixty times the latency of the watch that delivers it. Fires only on a CHANGE, because
   * every pass otherwise rebroadcasts identical state and re-renders every row.
   */
  onStatus?: (ptyId: string, status: ClaudeSessionStatus | null) => void
}

interface Controller {
  sessionId: string
  reported: ParkedJob | null
  pendingShortId: string | null
  /** When `pendingShortId` was first observed; the marker is reported CONFIRM_AFTER_MS later. */
  pendingSince: number
  /**
   * Last status handed to `onStatus`, so a pass that changes nothing emits nothing. `undefined`
   * means "never reported" and is distinct from `null` ("reported as having no claim"), or the first
   * genuine absence would be swallowed.
   */
  reportedStatus: ClaudeSessionStatus | null | undefined
}

/**
 * Watches Claude's private session registry on behalf of Switchboard-owned Claude PTYs, for two
 * INDEPENDENT facts that happen to live in the same file: the parked-agent marker, and the session's
 * own busy/idle. One directory watch, one poll, one read per file per pass; the two are parsed
 * separately because a record can support either claim without supporting the other.
 *
 * Consumers see per-PTY values only — registry records, pids, liveness checks and the parked
 * marker's confirmation policy stay behind this boundary. Watching runs only while Claude PTYs exist.
 */
export class ClaudeParkedJobMonitor {
  private readonly sessionsRoot: string
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly resolveJobName: (shortId: string) => string
  private readonly now: () => number
  private readonly onChange: (ptyId: string, parked: ParkedJob | null) => void
  private readonly onStatus?: (ptyId: string, status: ClaudeSessionStatus | null) => void
  private readonly controllers = new Map<string, Controller>()
  private watcher: NodeFsWatcher | null = null
  private poll: ReturnType<typeof setInterval> | null = null

  constructor(opts: ClaudeParkedJobMonitorOptions) {
    this.sessionsRoot = opts.sessionsRoot ?? join(homedir(), '.claude', 'sessions')
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive
    this.resolveJobName = opts.resolveJobName ?? ((shortId) => readBgJobName(shortId))
    this.now = opts.now ?? (() => Date.now())
    this.onChange = opts.onChange
    this.onStatus = opts.onStatus
  }

  register(ptyId: string, sessionId: string): void {
    this.controllers.set(ptyId, {
      sessionId,
      reported: null,
      pendingShortId: null,
      pendingSince: 0,
      reportedStatus: undefined
    })
    this.startWatching()
    this.refresh()
  }

  unregister(ptyId: string): void {
    this.controllers.delete(ptyId)
    if (this.controllers.size === 0) this.stopWatching()
  }

  dispose(): void {
    // Clearing the controllers is what stops `refresh` re-arming the watch, not just what stops the
    // reporting — see the guard at the top of `refresh`.
    this.controllers.clear()
    this.stopWatching()
  }

  private startWatching(): void {
    if (this.poll) return
    this.armWatcher()
    this.poll = setInterval(() => this.refresh(), REGISTRY_POLL_MS)
    this.poll.unref()
  }

  /**
   * (Re)attach the directory watch, which is what makes this feel instant — the poll is only the
   * backstop.
   *
   * Re-armed from `refresh` after a failure rather than abandoned. A watch can die for reasons that
   * do not persist (the registry directory replaced, a descriptor limit hit in a burst), and dropping
   * it permanently on the first error silently costs every later change its ~12 ms path and leaves
   * the poll interval as the only latency anyone sees. Cheap to retry: the next pass is already
   * scheduled, so this rides it rather than adding a timer.
   */
  private armWatcher(): void {
    if (this.watcher) return
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
      /* the registry directory may not exist yet; the poll is the reliable path until it does */
    }
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
    // Nothing to report and nothing to keep watching FOR — and this is also what keeps the watch from
    // coming back from the dead. `refresh` is called from the watch callback and re-arms the watch, so
    // an event still queued when the last PTY unregisters (or when the monitor is disposed) would
    // otherwise open a fresh watcher that no controller needs, doing synchronous directory scans for
    // nobody. One condition covers both exits because each empties `controllers`; two guards for one
    // rule is how they drift apart.
    if (this.controllers.size === 0) return
    this.armWatcher()
    const bySession = new Map<string, string>()
    const statusBySession = new Map<string, ClaudeSessionStatus>()
    // Whether this pass could read the registry AT ALL, which the two facts below answer to
    // differently — see the catch.
    let readable = true
    try {
      for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        try {
          // ONE read per file for both facts. They are parsed separately because they accept
          // different records, but re-reading the file for each would double the synchronous I/O
          // this does on the main process's event loop every pass.
          const text = readFileSync(join(this.sessionsRoot, entry.name), 'utf8')
          const record = parkedJobFromRegistry(text)
          // Claude leaves the record behind when a session dies, so a resumed conversation would
          // otherwise inherit the dead process's marker.
          if (record && this.isProcessAlive(record.pid)) {
            bySession.set(record.sessionId, record.shortId)
          }
          // Gated on the same liveness check and for the same reason: a stale record's last status
          // was written by a process that no longer exists, and a leftover `busy` would protect a
          // terminal that is doing nothing at all.
          const status = sessionStatusFromRegistry(text)
          if (status && this.isProcessAlive(status.pid)) {
            statusBySession.set(status.sessionId, status.status)
          }
        } catch {
          /* one unreadable record must not hide the rest */
        }
      }
    } catch {
      // The registry is absent entirely. The two facts diverge HERE, and the difference is the whole
      // reason this is a flag rather than an early return: holding is right for one and unsafe for
      // the other.
      readable = false
    }

    const now = this.now()
    // A registry that cannot be read cannot SUPPORT a claim about the present, so an unreadable pass
    // retracts the status rather than preserving it. `busy` resolves to `working`, which the cap
    // treats as an absolute veto — so a held `busy` is unbounded protection, reachable by nothing
    // more exotic than the directory going away, and that is the one failure mode this policy exists
    // to exclude. Retracting costs a working session its protection for a single pass (~150 ms, and
    // only a spawn in that window could act on it), which is the safe direction to be wrong in.
    //
    // **The retraction is the EMPTY MAP, and the ordering is what delivers it.** A failed `readdir`
    // throws before either map is filled, so the plain lookup below already yields null. Running
    // this loop ABOVE the return is therefore the whole mechanism — no path reaches it with an
    // unreadable registry and a populated map, so testing `readable` here would add nothing. Do not
    // move this loop below the return.
    for (const [ptyId, controller] of this.controllers) {
      const status = statusBySession.get(controller.sessionId) ?? null
      if (controller.reportedStatus === status) continue
      controller.reportedStatus = status
      this.onStatus?.(ptyId, status)
    }
    // The parked marker is a LABEL — "this session launched an agent", a fact about the past that
    // stays true while the registry is unreadable — so it is still held rather than falsely cleared.
    // Reporting it absent would replace a named row with an empty "New conversation" one.
    if (!readable) return
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
