import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import {
  CONFIG,
  type AgentKind,
  type PtyState,
  type PtyStatus,
  type PtySurface
} from '../../shared/types'
import { cleanAgentEnv } from './agentEnv'
import { bootPayloadFor } from './bootCommand'
import {
  ClaudeAgentViewMonitor,
  enterClaudeAgentView,
  exitClaudeAgentView,
  type ClaudeAgentViewMonitorOptions
} from './claudeAgentView'
import {
  resolveCodexBindings,
  type CodexBinding,
  type ProvisionalPty
} from './codexIdentity'
import { CodexInputNotificationScanner } from './codexInputNotifications'

/** The resolver seam, so tests can drive the orchestration without spawning `lsof`. */
export type CodexBindingResolver = (
  provisional: readonly ProvisionalPty[],
  eligibleSessionIds: ReadonlySet<string>
) => Promise<readonly CodexBinding[]>

/**
 * How many times one UNCHANGED state — the same provisional PTYs and the same eligible rollouts — is
 * probed EAGERLY, i.e. on every re-index. Three absorbs the ordinary race where a rollout is indexed a
 * beat before Codex has it open.
 */
const MAX_EAGER_PROBES_PER_STATE = 3

/**
 * How long to wait between probes once the eager budget for a state is spent.
 *
 * There MUST still be a retry, because the signature is built from Switchboard's inputs while the
 * answer depends on OS state that isn't in it — so "same inputs" does NOT imply "same answer". Two
 * real cases: a run of `lsof` timeouts inside the eager window burns it on transient failure; and if
 * the user Ctrl-Cs a new Codex terminal and types `codex resume <id>` by hand, that rollout was
 * ALREADY eligible at spawn, so its arrival changes nothing about the signature and cannot reset the
 * budget. A hard cap would leave both permanently unlinked with no way back.
 *
 * Ten seconds keeps the sustained cost near nothing (~0.1 probes/sec against a 2/sec re-index) while
 * still recovering on its own. Still no timer of its own — it only ever rides an existing re-index.
 */
const PROBE_RETRY_INTERVAL_MS = 10_000

interface Live {
  ptyId: string
  surface: PtySurface
  agent: AgentKind
  cwd: string
  title: string
  // What this PTY shows when it is NOT in Agent View, kept so leaving Agent View restores it.
  controllerCwd: string
  controllerTitle: string
  origin: 'resume' | 'new'
  proc: pty.IPty
  status: PtyStatus
  lastActivity: number
  startedAt: number
  inputRequestedAt: number | null
  idleTimer: ReturnType<typeof setTimeout> | null
  bootTimer: ReturnType<typeof setTimeout> | null
  // A new Codex session has no real id at spawn (Codex mints its own), so the PTY carries a
  // placeholder sessionId and stays `provisional` until an lsof probe PROVES which rollout the Codex
  // process in this terminal has open (see codexIdentity + probeCodexIdentity). Cleared on bind (or
  // when the PTY exits). While set, the row is a terminal with no known transcript — the renderer
  // surfaces that rather than guessing, so this crosses IPC on PtyState.
  provisional: boolean
  booted: boolean
  // Claude boots (the `claude` command is typed) only once the shell is ready AND the renderer
  // has sized the PTY to the real terminal dimensions. Booting before the resize makes claude
  // replay at the 80×30 spawn default; the real size then lands mid-replay and corrupts claude's
  // cursor math, leaving real blank rows in the buffer. See spawn() / resize().
  shellReady: boolean
  sized: boolean
  bootWhenReady: () => void
  exitCode: number | null
}

type AgentViewOptions = Omit<ClaudeAgentViewMonitorOptions, 'onHost' | 'onExit'>

function conversationId(surface: PtySurface): string | null {
  return surface.kind === 'conversation' ? surface.sessionId : null
}

/**
 * Owns every live PTY-backed agent session.
 *
 * Design notes:
 * - We spawn the user's LOGIN + INTERACTIVE shell as the PTY program, then type the
 *   `claude` command into it. A GUI Electron app inherits a minimal PATH (no
 *   ~/.local/bin, no Homebrew), so invoking `claude` directly would fail with
 *   ENOENT. A login shell sources the user's profile and gets the real PATH — and
 *   it gives a genuine terminal: when claude exits, you're back at a prompt.
 * - Busy vs idle is inferred from output activity (debounced). It does NOT drive the
 *   liveness dot (a live agent TUI repaints constantly — every keystroke echoes as output —
 *   so a PTY is ~always "busy"; transcript state drives the dot, with explicit Codex OSC input
 *   notifications as the narrow exception). Here it ONLY gates LRU eviction (we never kill busy
 *   work).
 */
export class PtyManager extends EventEmitter {
  private live = new Map<string, Live>()
  private readonly agentView: ClaudeAgentViewMonitor | null
  /** Injected only by tests; production always observes the real OS. */
  private resolveBindings: CodexBindingResolver
  // Probe budget state. `probeSig` is the (provisional PTYs × eligible rollouts) state the current
  // attempt count belongs to; `probeInFlight` collapses overlapping re-indexes onto one `lsof`;
  // `lastProbeAt` paces the slow retries that continue after the eager budget is spent.
  private probeSig: string | null = null
  private probeAttempts = 0
  private probeInFlight = false
  private lastProbeAt = 0
  // The live-PTY cap (CONFIG.maxLivePtys is the default). User-configurable at runtime via
  // setMaxLive, pushed from the renderer's Preferences over IPC.ptySetMaxLive. Read only at spawn
  // time (enforceCap), never on the per-output hot path.
  private maxLive: number = CONFIG.maxLivePtys

  constructor(
    opts: { claudeAgentView?: AgentViewOptions; resolveBindings?: CodexBindingResolver } = {}
  ) {
    super()
    this.agentView = opts.claudeAgentView
      ? new ClaudeAgentViewMonitor({
          ...opts.claudeAgentView,
          onHost: (ptyId) => this.enterAgentView(ptyId),
          onExit: (ptyId) => this.exitAgentView(ptyId)
        })
      : null
    // Dev/QA: SWITCHBOARD_FAKE_UNBOUND=1 makes every probe prove nothing, so the fail-closed
    // terminal-only state can actually be looked at. It is otherwise rare by design — binding
    // normally succeeds — which would leave the one state that must NOT be mistaken for liveness as
    // the one state nobody ever sees. Inert unless explicitly set.
    const fakeUnbound = process.env.SWITCHBOARD_FAKE_UNBOUND === '1'
    this.resolveBindings =
      opts.resolveBindings ?? (fakeUnbound ? async () => [] : resolveCodexBindings)
  }

  /**
   * Update the live-PTY cap, clamped to the shared bounds (a bad value can't disable the cap or
   * blow past the WebGL-context ceiling). Applies to subsequent spawns; does NOT retroactively
   * evict, so lowering it in Preferences never closes a running session out from under you.
   */
  setMaxLive(n: number): void {
    this.maxLive = Math.max(CONFIG.liveSessionsMin, Math.min(CONFIG.liveSessionsMax, Math.floor(n)))
  }

  resume(sessionId: string, cwd: string, agent: AgentKind, title = 'Conversation'): PtyState {
    return this.spawn({ sessionId, cwd, title, origin: 'resume', agent })
  }

  startNew(cwd: string, agent: AgentKind): PtyState {
    if (agent === 'codex') return this.startNewCodex(cwd)
    // Claude gets a pre-assigned id and is live (and renamable) immediately.
    return this.spawn({
      sessionId: randomUUID(),
      cwd,
      title: 'New conversation',
      origin: 'new',
      agent: 'claude'
    })
  }

  /**
   * Start a new Codex session. Codex mints its OWN rollout id (and only writes the rollout at the
   * first turn), so we spawn with a placeholder sessionId and mark the PTY `provisional`. The real id
   * is swapped in later by probeCodexIdentity, once the OS can prove which rollout the Codex process
   * in this terminal has open — and stays a placeholder if it never can.
   */
  private startNewCodex(cwd: string): PtyState {
    return this.spawn({
      sessionId: randomUUID(), // placeholder; swapped for the real rollout id on bind
      cwd,
      title: 'New Codex conversation',
      origin: 'new',
      agent: 'codex',
      provisional: true
    })
  }

  /**
   * Type renderer input into a PTY. Deliberately a transparent passthrough with NO identity
   * bookkeeping: keystrokes were once inspected here to time-correlate a new Codex PTY to its
   * rollout, and every variant of that (a bare `\r`, a discrete post-boot Enter, nearest-timestamp
   * pairing) was defeated by a real counterexample. Identity now comes from the OS instead — see
   * codexIdentity — so this is back to being the hot path it should be.
   */
  write(ptyId: string, data: string): void {
    this.live.get(ptyId)?.proc.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const e = this.live.get(ptyId)
    if (!e || cols < 1 || rows < 1) return
    try {
      e.proc.resize(Math.floor(cols), Math.floor(rows))
    } catch {
      /* pty may have just exited */
    }
    // First real size from the renderer: claude can now boot (once the shell is also ready) and
    // replay at the true dimensions instead of the 80×30 spawn default. See spawn()/bootWhenReady.
    if (!e.sized) {
      e.sized = true
      e.bootWhenReady()
    }
  }

  kill(ptyId: string): void {
    const e = this.live.get(ptyId)
    if (!e) return
    try {
      e.proc.kill()
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const e of this.live.values()) {
      try {
        e.proc.kill()
      } catch {
        /* ignore */
      }
    }
    this.live.clear()
    this.agentView?.dispose()
  }

  list(): PtyState[] {
    return [...this.live.values()].map((e) => this.toState(e))
  }

  /** Find a live PTY already driving a session, if any. */
  findBySession(sessionId: string): PtyState | null {
    for (const e of this.live.values()) {
      if (
        conversationId(e.surface) === sessionId ||
        (e.surface.kind === 'agent-view-host' && e.surface.controllerSessionId === sessionId)
      ) {
        return this.toState(e)
      }
    }
    return null
  }

  /** Is any live PTY still waiting to learn its conversation? Lets the re-index path skip building the
   *  eligible-id set entirely in the common case — that runs on the live poll, twice a second. */
  hasProvisionalCodex(): boolean {
    for (const e of this.live.values()) {
      if (e.agent === 'codex' && e.provisional) return true
    }
    return false
  }

  /**
   * Ask the OS which rollout each unbound provisional new-Codex PTY is actually running, and bind the
   * ones it can prove. Driven by the re-index path rather than a timer of its own: a new Codex rollout
   * only reaches disk at its first turn, and that write is exactly what wakes both the file watcher
   * and the live poll — so the probe rides indexing that already happens.
   *
   * `eligibleSessionIds` must be the FULLY FILTERED indexed set, so archived, non-interactive,
   * zero-message and `thread_source:"subagent"` rollouts can never become bind targets even while
   * Codex holds their files open (it really does hold subagent rollouts open alongside its own).
   * Sessions a live PTY already drives are subtracted here.
   *
   * Never throws and never blocks its caller's own work — callers should not await it. Costs nothing
   * when nothing is provisional, which is the overwhelmingly common case.
   */
  async probeCodexIdentity(eligibleSessionIds: ReadonlySet<string>): Promise<void> {
    const provisional: ProvisionalPty[] = []
    for (const e of this.live.values()) {
      if (e.agent === 'codex' && e.provisional) {
        provisional.push({ ptyId: e.ptyId, shellPid: e.proc.pid })
      }
    }
    // Nothing to identify. No budget reset is needed on the way out: a PTY never returns to
    // provisional, so the next one carries a fresh ptyId and pid and its signature differs anyway —
    // and at most one stale signature is ever held, since the next probe overwrites it.
    if (provisional.length === 0) return

    const owned = this.ownedSessionIds()
    const candidates = new Set<string>()
    for (const id of eligibleSessionIds) {
      if (!owned.has(id)) candidates.add(id)
    }
    // No unclaimed rollout exists yet — typically the window between opening a Codex tab and sending
    // its first prompt. There is nothing to bind to, so don't spend an attempt looking.
    if (candidates.size === 0) return

    const sig = probeSignature(provisional, candidates)
    if (sig !== this.probeSig) {
      this.probeSig = sig
      this.probeAttempts = 0
    }
    // Coalesce: an overlapping re-index joins the in-flight probe instead of starting a second one,
    // and does NOT consume an attempt (only a launched probe does).
    if (this.probeInFlight) return
    // Eager for the first few attempts on a state, then paced — never permanently abandoned, because
    // the answer can change while the inputs don't (see PROBE_RETRY_INTERVAL_MS).
    const now = Date.now()
    if (
      this.probeAttempts >= MAX_EAGER_PROBES_PER_STATE &&
      now - this.lastProbeAt < PROBE_RETRY_INTERVAL_MS
    ) {
      return
    }

    this.probeAttempts += 1
    this.lastProbeAt = now
    this.probeInFlight = true
    try {
      const bindings = await this.resolveBindings(provisional, candidates)
      // Cleared BEFORE applying: bindCodex emits `bound` / `active-changed` into the renderer
      // broadcast, and a throwing listener must not leave this flag stuck true, which would wedge
      // binding for the rest of the PTY's life.
      this.probeInFlight = false
      this.applyBindings(bindings, provisional, candidates)
    } catch {
      // The resolver is contracted to fail closed rather than reject. This also absorbs a throw from
      // a broadcast listener, which would otherwise escape as an unhandled rejection (callers invoke
      // this with `void`).
    } finally {
      this.probeInFlight = false
    }
  }

  /** Every sessionId a live PTY currently claims, including provisional placeholders — harmless,
   *  since a placeholder is a random UUID that cannot collide with a real rollout id. A Claude PTY
   *  sitting in Agent View claims none, which is what makes it safe to leave out. */
  private ownedSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const e of this.live.values()) {
      const id = conversationId(e.surface)
      if (id) ids.add(id)
    }
    return ids
  }

  /**
   * Apply a probe result, re-checking that the world it described still exists. `lsof` runs
   * asynchronously, so between the snapshot and here a PTY can exit or be replaced, and the user can
   * have resumed the very conversation the result names — and applying a stale identity is the exact
   * failure this whole rewrite exists to prevent.
   *
   * Only checks `bindCodex` CANNOT make are made here. Ownership and still-provisional are its job, so
   * they live there once rather than in two places that could drift apart — and a duplicate guard is
   * unreachable, which means untestable, which is how a suite goes green over a rule it never
   * exercises. A ptyId that was never probed is likewise caught by the pid check, since it has no
   * snapshot to match.
   */
  private applyBindings(
    bindings: readonly CodexBinding[],
    probed: readonly ProvisionalPty[],
    probedCandidates: ReadonlySet<string>
  ): void {
    if (bindings.length === 0) return
    const pidAtProbe = new Map(probed.map((p) => [p.ptyId, p.shellPid]))
    for (const { ptyId, sessionId } of bindings) {
      const e = this.live.get(ptyId)
      if (!e) continue // exited while the probe ran
      if (e.proc.pid !== pidAtProbe.get(ptyId)) continue // replaced, or never probed at all
      if (!probedCandidates.has(sessionId)) continue // not the set this result was computed against
      this.bindCodex(ptyId, sessionId)
    }
  }

  /** Swap a provisional Codex PTY's placeholder id for the real rollout id, then announce it: a
   *  `bound` event (so the renderer re-keys its session-keyed state) followed by `active-changed`. */
  private bindCodex(ptyId: string, realSessionId: string): void {
    const entry = this.live.get(ptyId)
    if (!entry || !entry.provisional || entry.surface.kind !== 'conversation') return
    // Defensive: never bind onto an id another live PTY already owns.
    for (const e of this.live.values()) {
      if (e.ptyId !== ptyId && conversationId(e.surface) === realSessionId) return
    }
    const oldSessionId = entry.surface.sessionId
    entry.surface = { kind: 'conversation', sessionId: realSessionId }
    entry.provisional = false
    this.emit('bound', ptyId, oldSessionId, realSessionId)
    this.emitActive()
  }

  private spawn(o: {
    sessionId: string
    cwd: string
    title: string
    origin: 'resume' | 'new'
    agent: AgentKind
    provisional?: boolean
  }): PtyState {
    // Don't double-spawn a session that's already live — just hand back the existing one.
    const existing = this.findBySession(o.sessionId)
    if (existing) return existing

    this.enforceCap()

    const shell = process.env.SHELL || '/bin/zsh'
    const ptyId = randomUUID()
    const proc = pty.spawn(shell, ['-l', '-i'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd: o.cwd,
      env: {
        ...cleanAgentEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        // a breadcrumb so a shell rc can special-case Switchboard if desired
        SWITCHBOARD: '1'
      }
    })

    const now = Date.now()
    const entry: Live = {
      ptyId,
      surface: { kind: 'conversation', sessionId: o.sessionId },
      agent: o.agent,
      cwd: o.cwd,
      title: o.title,
      controllerCwd: o.cwd,
      controllerTitle: o.title,
      origin: o.origin,
      proc,
      status: 'busy',
      lastActivity: now,
      startedAt: now,
      inputRequestedAt: null,
      idleTimer: null,
      bootTimer: null,
      provisional: o.provisional ?? false,
      booted: false,
      shellReady: false,
      sized: false,
      bootWhenReady: () => {},
      exitCode: null
    }
    this.live.set(ptyId, entry)
    if (o.agent === 'claude') this.agentView?.register(ptyId, o.sessionId)

    const boot = (): void => {
      if (entry.booted) return
      entry.booted = true
      if (entry.bootTimer) clearTimeout(entry.bootTimer)
      // Clear any stray content on the shell's input line (a recalled-history line from an up-arrow,
      // or a keystroke typed in the brief window before boot) before typing the command, so nothing
      // fuses onto it; the trailing \r submits. See bootPayloadFor.
      proc.write(bootPayloadFor(o.agent, o.origin, o.sessionId))
    }
    // Boot claude only once the shell is ready (first output) AND the renderer has sized the PTY
    // (first resize). Booting earlier starts claude's resume replay at the 80×30 spawn default; the
    // real size then arrives mid-replay as a SIGWINCH and corrupts claude's cursor math, leaving
    // real blank rows in the buffer (only a later resize/relayout clears them). Gating on `sized`
    // makes claude replay at the true terminal size from its first line. See resize().
    const bootWhenReady = (): void => {
      if (entry.shellReady && entry.sized) boot()
    }
    entry.bootWhenReady = bootWhenReady
    // Fallback: a terminal created while hidden may never send a resize — boot anyway so claude
    // always starts. Generous, since a visible terminal sends its first resize within a frame.
    entry.bootTimer = setTimeout(boot, 2500)
    const inputNotifications =
      o.agent === 'codex' ? new CodexInputNotificationScanner() : null

    proc.onData((data) => {
      if (!entry.shellReady) {
        entry.shellReady = true
        bootWhenReady()
      }
      const now = Date.now()
      const inputRequested = inputNotifications?.push(data) ?? false
      entry.lastActivity = now
      if (inputRequested) entry.inputRequestedAt = now
      const activeEmitted = this.markBusy(entry)
      if (inputRequested && !activeEmitted) this.emitActive()
      this.emit('data', ptyId, data)
    })

    proc.onExit(({ exitCode }) => {
      entry.status = 'exited'
      entry.exitCode = exitCode ?? 0
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      if (entry.bootTimer) clearTimeout(entry.bootTimer)
      this.agentView?.unregister(ptyId)
      this.live.delete(ptyId)
      this.emit('exit', ptyId, entry.exitCode)
      this.emitActive()
    })

    this.emitActive()
    return this.toState(entry)
  }

  private markBusy(e: Live): boolean {
    const wasBusy = e.status === 'busy'
    e.status = 'busy'
    if (e.idleTimer) clearTimeout(e.idleTimer)
    e.idleTimer = setTimeout(() => {
      if (e.status === 'exited') return
      e.status = 'idle'
      this.emitActive()
    }, CONFIG.busyWindowMs)
    if (!wasBusy) this.emitActive()
    return !wasBusy
  }

  /**
   * Keep the live set bounded. Evict the least-recently-active IDLE session.
   * If everything is busy we let the set grow rather than kill active work.
   */
  private enforceCap(): void {
    if (this.live.size < this.maxLive) return
    const idle = [...this.live.values()]
      .filter((l) => l.status === 'idle')
      .sort((a, b) => a.lastActivity - b.lastActivity)
    if (idle.length > 0) this.kill(idle[0].ptyId)
  }

  private toState(e: Live): PtyState {
    return {
      ptyId: e.ptyId,
      surface: e.surface,
      agent: e.agent,
      cwd: e.cwd,
      title: e.title,
      status: e.status,
      lastActivity: e.lastActivity,
      startedAt: e.startedAt,
      inputRequestedAt: e.inputRequestedAt,
      origin: e.origin,
      provisional: e.provisional,
      exitCode: e.exitCode
    }
  }

  private emitActive(): void {
    this.emit('active-changed', this.list())
  }

  private enterAgentView(ptyId: string): void {
    const entry = this.live.get(ptyId)
    if (!entry || entry.agent !== 'claude' || entry.surface.kind === 'agent-view-host') return
    entry.surface = enterClaudeAgentView(entry.surface)
    entry.cwd = entry.controllerCwd
    entry.title = 'Claude Agent View'
    this.emitSurfaceChanged()
  }

  private exitAgentView(ptyId: string): void {
    const entry = this.live.get(ptyId)
    if (!entry || entry.surface.kind !== 'agent-view-host') return
    entry.surface = exitClaudeAgentView(entry.surface)
    entry.cwd = entry.controllerCwd
    entry.title = entry.controllerTitle
    this.emitSurfaceChanged()
  }

  private emitSurfaceChanged(): void {
    this.emit('surface-changed')
    this.emitActive()
  }
}

/**
 * Identity of one probe's INPUTS, so an unchanged state isn't probed forever. Order-independent (both
 * sides sorted), because neither the live-PTY map's iteration order nor the index's ordering is
 * meaningful — only membership is.
 */
function probeSignature(
  provisional: readonly ProvisionalPty[],
  candidates: ReadonlySet<string>
): string {
  const ptys = provisional
    .map((p) => `${p.ptyId}:${p.shellPid}`)
    .sort()
    .join(',')
  return `${ptys}|${[...candidates].sort().join(',')}`
}
