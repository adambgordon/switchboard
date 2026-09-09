import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import {
  CONFIG,
  type AgentKind,
  type PtyBindKind,
  type PtySession,
  type PtyStatus
} from '../../shared/types'
import { cleanAgentEnv } from './agentEnv'
import { bootPayloadFor } from './bootCommand'
import {
  resolveCodexBindings,
  type CodexBinding,
  type CodexPtyTarget
} from './codexIdentity'
import { CodexInputNotificationScanner } from './codexInputNotifications'
import {
  ClaudeParkedJobMonitor,
  type ClaudeParkedJobMonitorOptions,
  type ParkedJob
} from './claudeParkedJobs'

type ParkedJobOptions = Omit<ClaudeParkedJobMonitorOptions, 'onChange'>

/** The resolver seam, so tests can drive the orchestration without spawning `lsof`. */
export type CodexBindingResolver = (
  targets: readonly CodexPtyTarget[],
  eligibleSessionIds: ReadonlySet<string>
) => Promise<readonly CodexBinding[]>

/**
 * How many times one UNCHANGED state — the same Codex PTY targets and the same eligible rollouts — is
 * probed EAGERLY, i.e. on every re-index. Three absorbs the ordinary race where a rollout is indexed a
 * beat before Codex has it open.
 */
const MAX_EAGER_PROBES_PER_STATE = 3

/**
 * How long to wait between probes once the eager budget for a state is spent, while some live Codex
 * terminal's identity is still UNPROVEN.
 *
 * There MUST still be a retry, because the signature is built from Switchboard's inputs while the
 * answer depends on OS state that isn't in it — so "same inputs" does NOT imply "same answer". Two
 * real cases: a run of `lsof` timeouts inside the eager window burns it on transient failure; and a
 * resumed terminal cannot be proven until Codex has actually booted and opened the rollout, which
 * takes longer than the eager burst. A hard cap would leave both permanently unproven with no way
 * back.
 *
 * Once EVERY live Codex PTY is confirmed the pacing stops entirely rather than idling on, so a
 * settled app costs nothing; a change to the observed state (a new terminal, a new conversation)
 * resets the eager budget and starts it again. Ten seconds keeps the unsettled cost near nothing
 * (~0.1 probes/sec against a 2/sec re-index). Still no timer of its own — it only ever rides an
 * existing re-index.
 */
const PROBE_RETRY_INTERVAL_MS = 10_000

interface Live {
  ptyId: string
  sessionId: string
  agent: AgentKind
  cwd: string
  title: string
  origin: 'resume' | 'new'
  proc: pty.IPty
  status: PtyStatus
  lastActivity: number
  startedAt: number
  inputRequestedAt: number | null
  // [Codex] Streaming OSC 9 scanner for this terminal. Held on the entry rather than only in the
  // onData closure so an identity correction can reset it: its `partial` buffer is per-PROCESS
  // state, and a half-written sequence from a replaced process must not be completed by the next
  // one's output. Null for Claude.
  inputScanner: CodexInputNotificationScanner | null
  idleTimer: ReturnType<typeof setTimeout> | null
  bootTimer: ReturnType<typeof setTimeout> | null
  // A new Codex session has no real id at spawn (Codex mints its own), so the PTY carries a
  // placeholder sessionId and stays `provisional` until an lsof probe PROVES which rollout the Codex
  // process in this terminal has open (see codexIdentity + probeCodexIdentity). Cleared on bind (or
  // when the PTY exits). While set, the row is a terminal with no known transcript — the renderer
  // surfaces that rather than guessing, so this crosses IPC on PtySession.
  provisional: boolean
  // [Codex] Has the OS ever positively identified this terminal's conversation? Deliberately separate
  // from `provisional`, which is about what the RENDERER shows: a RESUMED PTY is not provisional (the
  // click supplied a real id) yet its identity is still only asserted, never observed. Identity is
  // MAINTAINED here, not just established — a Switchboard terminal is a real login shell that outlives
  // any one Codex process, so a terminal can move to a different conversation (quit Codex, cd, start
  // again) long after it bound. Only the paced retry keys off this: while any live Codex PTY is
  // unconfirmed we keep asking, and once they all are, probing goes quiet until the observed state
  // changes.
  identityConfirmed: boolean
  // [Claude] The background agent this session launched, once its registry marker is confirmed. Says
  // nothing about what the terminal is currently showing — see claudeParkedJobs.
  parkedJob: ParkedJob | null
  booted: boolean
  // Claude boots (the `claude` command is typed) only once the shell is ready AND the renderer
  // has sized the PTY to the real terminal dimensions. Booting before the resize makes claude
  // replay at the 80×30 spawn default; the real size then lands mid-replay and corrupts claude's
  // cursor math, leaving real blank rows in the buffer. See spawn() / resize().
  shellReady: boolean
  sized: boolean
  bootWhenReady: () => void
  exitCode: number | null
  /** Independent reasons holding node-pty's readable side paused (renderer backpressure or transfer). */
  flowPauses: Set<string>
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
  /** Injected only by tests; production always observes the real OS. */
  private resolveBindings: CodexBindingResolver
  // Probe budget state. `probeSig` is the (Codex PTY targets × eligible rollouts) state the current
  // attempt count belongs to; `probeInFlight` collapses overlapping re-indexes onto one `lsof`;
  // `lastProbeAt` paces the slow retries that continue after the eager budget is spent.
  private probeSig: string | null = null
  private probeAttempts = 0
  private probeInFlight = false
  private lastProbeAt = 0
  private readonly parkedJobs: ClaudeParkedJobMonitor | null
  /**
   * Dev/QA: SWITCHBOARD_FAKE_PARKED=1 gives every new Claude PTY a background agent, so the
   * work-went-to-an-agent row can actually be looked at. Same reasoning as SWITCHBOARD_FAKE_UNBOUND
   * below — it needs a session that launches an agent and then writes NO transcript of its own, which
   * cannot be produced on demand, leaving a row nobody can review before it ships. Inert unless set.
   */
  private readonly fakeParkedJob: ParkedJob | null

  constructor(
    opts: { resolveBindings?: CodexBindingResolver; claudeParkedJobs?: ParkedJobOptions } = {}
  ) {
    super()
    this.fakeParkedJob =
      process.env.SWITCHBOARD_FAKE_PARKED === '1'
        ? { shortId: 'fa4e0000', name: 'Example background agent (fake)' }
        : null
    // Dev/QA: SWITCHBOARD_FAKE_UNBOUND=1 makes every probe prove nothing, so the fail-closed
    // terminal-only state can actually be looked at. It is otherwise rare by design — binding
    // normally succeeds — which would leave the one state that must NOT be mistaken for liveness as
    // the one state nobody ever sees. Inert unless explicitly set.
    const fakeUnbound = process.env.SWITCHBOARD_FAKE_UNBOUND === '1'
    this.resolveBindings =
      opts.resolveBindings ?? (fakeUnbound ? async () => [] : resolveCodexBindings)
    this.parkedJobs = opts.claudeParkedJobs
      ? new ClaudeParkedJobMonitor({
          ...opts.claudeParkedJobs,
          onChange: (ptyId, parked) => this.setParkedJob(ptyId, parked)
        })
      : null
  }

  private setParkedJob(ptyId: string, parked: ParkedJob | null): void {
    const entry = this.live.get(ptyId)
    if (!entry) return
    entry.parkedJob = parked
    this.emitActive()
  }

  // The live-PTY cap (CONFIG.maxLivePtys is the default). User-configurable at runtime via
  // setMaxLive, pushed from the renderer's Preferences over IPC.ptySetMaxLive. Read only at spawn
  // time (enforceCap), never on the per-output hot path.
  private maxLive: number = CONFIG.maxLivePtys

  /**
   * Update the live-PTY cap, clamped to the shared bounds (a bad value can't disable the cap or
   * blow past the WebGL-context ceiling). Applies to subsequent spawns; does NOT retroactively
   * evict, so lowering it in Preferences never closes a running session out from under you.
   */
  setMaxLive(n: number): void {
    this.maxLive = Math.max(CONFIG.liveSessionsMin, Math.min(CONFIG.liveSessionsMax, Math.floor(n)))
  }

  resume(
    sessionId: string,
    cwd: string,
    agent: AgentKind,
    title = 'Conversation',
    beforeAnnounce?: (session: PtySession) => void
  ): PtySession {
    return this.spawn({ sessionId, cwd, title, origin: 'resume', agent, beforeAnnounce })
  }

  startNew(cwd: string, agent: AgentKind, beforeAnnounce?: (session: PtySession) => void): PtySession {
    if (agent === 'codex') return this.startNewCodex(cwd, beforeAnnounce)
    // Claude gets a pre-assigned id and is live (and renamable) immediately.
    return this.spawn({
      sessionId: randomUUID(),
      cwd,
      title: 'New conversation',
      origin: 'new',
      agent: 'claude',
      beforeAnnounce
    })
  }

  /**
   * Start a new Codex session. Codex mints its OWN rollout id (and only writes the rollout at the
   * first turn), so we spawn with a placeholder sessionId and mark the PTY `provisional`. The real id
   * is swapped in later by probeCodexIdentity, once the OS can prove which rollout the Codex process
   * in this terminal has open — and stays a placeholder if it never can.
   */
  private startNewCodex(cwd: string, beforeAnnounce?: (session: PtySession) => void): PtySession {
    return this.spawn({
      sessionId: randomUUID(), // placeholder; swapped for the real rollout id on bind
      cwd,
      // Same wording as a new Claude session: at this point neither has done anything, and the row
      // already carries the agent's logo — spelling the agent out here only made the two look unlike.
      title: 'New conversation',
      origin: 'new',
      agent: 'codex',
      provisional: true,
      beforeAnnounce
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

  /** Pause/resume output without letting one caller release another caller's hold. */
  setOutputPaused(ptyId: string, reason: string, paused: boolean): void {
    const e = this.live.get(ptyId)
    if (!e) return
    if (paused) {
      if (e.flowPauses.has(reason)) return
      const wasFlowing = e.flowPauses.size === 0
      e.flowPauses.add(reason)
      if (wasFlowing) {
        try {
          e.proc.pause()
        } catch {
          /* pty may have just exited */
        }
      }
      return
    }
    if (!e.flowPauses.delete(reason) || e.flowPauses.size > 0) return
    try {
      e.proc.resume()
    } catch {
      /* pty may have just exited */
    }
  }

  /** A renderer disappeared while holding backpressure; never leave its PTYs paused forever. */
  releaseOutputPause(reason: string): void {
    for (const e of this.live.values()) {
      if (!e.flowPauses.delete(reason) || e.flowPauses.size > 0) continue
      try {
        e.proc.resume()
      } catch {
        /* pty may have just exited */
      }
    }
  }

  /** Force a sized PTY to repaint its current screen for a renderer that has just claimed it. */
  repaint(ptyId: string): void {
    const e = this.live.get(ptyId)
    if (!e || !e.sized) return
    const { cols, rows } = e.proc
    try {
      // A same-size resize is a no-op for an idle shell. Step one column out and immediately back so
      // the foreground process receives SIGWINCH while its final geometry remains unchanged.
      e.proc.resize(cols + 1, rows)
      e.proc.resize(cols, rows)
    } catch {
      /* pty may have just exited */
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
    this.parkedJobs?.dispose()
  }

  list(): PtySession[] {
    return [...this.live.values()].map((e) => this.toState(e))
  }

  /** Find a live PTY already driving a session, if any. */
  findBySession(sessionId: string): PtySession | null {
    for (const e of this.live.values()) {
      if (e.sessionId === sessionId) return this.toState(e)
    }
    return null
  }

  /** Is any live PTY's Codex identity worth asking the OS about? EVERY live Codex PTY is, not only the
   *  ones still waiting to learn their conversation — see `identityConfirmed`. Lets the re-index path
   *  skip building the eligible-id set entirely when no Codex session is live at all; that path runs on
   *  the live poll, twice a second. */
  hasCodexToProbe(): boolean {
    for (const e of this.live.values()) {
      if (e.agent === 'codex') return true
    }
    return false
  }

  /**
   * Ask the OS which rollout each live Codex PTY is actually running, and act on what it can prove:
   * bind a terminal that had no identity, and CORRECT one whose identity has since drifted. Driven by
   * the re-index path rather than a timer of its own: a Codex rollout reaches disk at its first turn,
   * and that write is exactly what wakes both the file watcher and the live poll — so the probe rides
   * indexing that already happens.
   *
   * Every live Codex PTY is asked about, not just the provisional ones. Identity was previously proven
   * once and then assumed permanent, which is wrong for two reasons: a resumed PTY's id came from a
   * click and was never observed at all, and a bound terminal is a login shell that outlives the Codex
   * process it was bound against — quit Codex, `cd`, start it again, and the row keeps naming a
   * conversation the terminal is no longer running.
   *
   * `eligibleSessionIds` must be the FULLY FILTERED indexed set, so archived, non-interactive,
   * zero-message and delegated subagent/review rollouts can never become bind targets even while
   * Codex holds their files open (it really does hold subagent rollouts open alongside its own).
   *
   * It is passed through UNMODIFIED — in particular, ids that live PTYs already own are NOT subtracted,
   * and that is load-bearing. A terminal's own current rollout must stay a candidate so that a terminal
   * holding two eligible rollouts still trips the resolver's ambiguity rule and yields nothing; drop
   * the own-id and the second rollout would look like the single unambiguous answer, turning a settled,
   * correct terminal into a wrong one. Binding onto an id another live PTY holds is refused by
   * `bindCodex`, and a conversation open on two terminals is refused by the resolver's own rule 6, so
   * nothing is lost by keeping the set whole.
   *
   * Never throws and never blocks its caller's own work — callers should not await it. Costs nothing
   * while every live Codex terminal is confirmed and the observed state is unchanged, which is the
   * overwhelmingly common case.
   */
  async probeCodexIdentity(eligibleSessionIds: ReadonlySet<string>): Promise<void> {
    const targets: CodexPtyTarget[] = []
    let anyUnconfirmed = false
    for (const e of this.live.values()) {
      if (e.agent !== 'codex') continue
      targets.push({ ptyId: e.ptyId, shellPid: e.proc.pid })
      if (!e.identityConfirmed) anyUnconfirmed = true
    }
    // Nothing to identify.
    if (targets.length === 0) return
    // No rollout exists to be running — only reachable on a machine with no indexed Codex history at
    // all. There is nothing to prove against, so don't spend an attempt looking.
    if (eligibleSessionIds.size === 0) return

    const sig = probeSignature(targets, eligibleSessionIds)
    if (sig !== this.probeSig) {
      this.probeSig = sig
      this.probeAttempts = 0
    }
    // Coalesce: an overlapping re-index joins the in-flight probe instead of starting a second one,
    // and does NOT consume an attempt (only a launched probe does).
    if (this.probeInFlight) return
    const now = Date.now()
    if (this.probeAttempts >= MAX_EAGER_PROBES_PER_STATE) {
      // The eager budget for this state is spent. Keep going only while some terminal's identity is
      // still unproven, because there the answer can change while the inputs don't (see
      // PROBE_RETRY_INTERVAL_MS). Once every one is confirmed, stop: re-validation then rides changes
      // to the observed state — a new terminal, or a new conversation appearing — which move the
      // signature and hand back a fresh eager budget. That keeps a settled app at zero probes.
      if (!anyUnconfirmed) return
      if (now - this.lastProbeAt < PROBE_RETRY_INTERVAL_MS) return
    }

    this.probeAttempts += 1
    this.lastProbeAt = now
    this.probeInFlight = true
    try {
      const bindings = await this.resolveBindings(targets, eligibleSessionIds)
      // Cleared BEFORE applying: bindCodex emits `bound` / `active-changed` into the renderer
      // broadcast, and a throwing listener must not leave this flag stuck true, which would wedge
      // binding for the rest of the PTY's life.
      this.probeInFlight = false
      this.applyBindings(bindings, targets, eligibleSessionIds)
    } catch {
      // The resolver is contracted to fail closed rather than reject. This also absorbs a throw from
      // a broadcast listener, which would otherwise escape as an unhandled rejection (callers invoke
      // this with `void`).
    } finally {
      this.probeInFlight = false
    }
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
    probed: readonly CodexPtyTarget[],
    probedCandidates: ReadonlySet<string>
  ): void {
    if (bindings.length === 0) return
    const pidAtProbe = new Map(probed.map((p) => [p.ptyId, p.shellPid]))
    const applied = new Set<string>()
    for (const { ptyId, sessionId } of bindings) {
      // A result naming one PTY twice is contradictory. Take the first usable entry and refuse the
      // rest: a second one would otherwise overwrite a binding just applied from the same answer.
      // Previously this fell out of `provisional` being cleared by the first bind — a correction has
      // no such flag to spend, so the rule has to be stated.
      if (applied.has(ptyId)) continue
      const e = this.live.get(ptyId)
      if (!e) continue // exited while the probe ran
      if (e.proc.pid !== pidAtProbe.get(ptyId)) continue // replaced, or never probed at all
      if (!probedCandidates.has(sessionId)) continue // not the set this result was computed against
      applied.add(ptyId)
      if (e.sessionId === sessionId) {
        // The terminal is running exactly what the row already says. Nothing to announce — just record
        // that the identity is now OS-proven rather than merely assumed, which is what lets the paced
        // retry stop. This is the ONLY place a correct-but-unobserved PTY (a resumed one) settles.
        e.identityConfirmed = true
        continue
      }
      this.bindCodex(ptyId, sessionId)
    }
  }

  /**
   * Point a Codex PTY at the rollout the OS just proved it is running, then announce it: a `bound`
   * event carrying a `PtyBindKind`, followed by `active-changed`.
   *
   * Serves both the FIRST identification of a provisional terminal and the CORRECTION of one that has
   * drifted to another conversation. There is deliberately no `provisional` gate here — refusing to
   * move an established id is exactly what let a stale identity outlive the process it described.
   *
   * The two are NOT the same operation downstream, which is why `kind` is emitted rather than left
   * for the renderer to infer: an initial bind migrates everything off a placeholder that is ceasing
   * to exist, while a correction leaves CONVERSATION-owned state (persisted seen/unread, earlier
   * history stops) on the id that owns it and moves only terminal-owned state — the selection, the
   * current history stop, its surface, the Live slot. See PtyBindKind and lib/bindPolicy.ts.
   *
   * Event ORDER is load-bearing: `bound` must precede `active-changed`, because the renderer uses
   * `bound` to keep the Live row in its slot before the new id arrives in the active list and the
   * order sync would otherwise read the same terminal as newly live.
   *
   * The caller supplies only Codex PTYs it probed, and only when the observed id differs from the
   * current one.
   */
  private bindCodex(ptyId: string, realSessionId: string): void {
    const entry = this.live.get(ptyId)
    if (!entry) return
    // Defensive: never bind onto an id another live PTY already owns.
    for (const e of this.live.values()) {
      if (e.ptyId !== ptyId && e.sessionId === realSessionId) return
    }
    const oldSessionId = entry.sessionId
    // Read BEFORE clearing: `provisional` is what distinguishes replacing a throwaway placeholder
    // from correcting a terminal that has moved between two real conversations. The renderer handles
    // those oppositely and cannot tell them apart from the ids — see PtyBindKind.
    const kind: PtyBindKind = entry.provisional ? 'initial' : 'correction'
    if (kind === 'correction') {
      // Conversation-specific RUNTIME state must not ride along onto a different conversation. An
      // OSC input-request timestamp says "this conversation is waiting on you", and it takes
      // precedence over transcript-derived liveness — so left in place after a correction the row
      // would pulse `asking` for an approval that belongs to the conversation the terminal LEFT, and
      // generic TUI output cannot clear it by design. Correcting identity while leaving the dot
      // describing someone else's turn is the same class of lie this whole path exists to remove.
      // Not cleared on an `initial` bind: there the notification came from the very process whose
      // rollout is being named, so it is genuinely about the new id.
      entry.inputRequestedAt = null
      // The scalar is only half of it — the scanner's buffer is per-process state too. A sequence
      // left half-written by the replaced process would otherwise be completed by the NEXT process's
      // terminator, splicing the old payload onto new output and manufacturing a request nobody
      // made. Clearing one and not the other fixes the visible symptom and leaves the cause.
      entry.inputScanner?.reset()
    }
    entry.sessionId = realSessionId
    entry.provisional = false
    entry.identityConfirmed = true
    this.emit('bound', ptyId, oldSessionId, realSessionId, kind)
    this.emitActive()
  }

  private spawn(o: {
    sessionId: string
    cwd: string
    title: string
    origin: 'resume' | 'new'
    agent: AgentKind
    provisional?: boolean
    beforeAnnounce?: (session: PtySession) => void
  }): PtySession {
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
      sessionId: o.sessionId,
      agent: o.agent,
      cwd: o.cwd,
      title: o.title,
      origin: o.origin,
      proc,
      status: 'busy',
      lastActivity: now,
      startedAt: now,
      inputRequestedAt: null,
      inputScanner: o.agent === 'codex' ? new CodexInputNotificationScanner() : null,
      idleTimer: null,
      bootTimer: null,
      provisional: o.provisional ?? false,
      identityConfirmed: false,
      parkedJob: o.agent === 'claude' ? this.fakeParkedJob : null,
      booted: false,
      shellReady: false,
      sized: false,
      bootWhenReady: () => {},
      exitCode: null,
      flowPauses: new Set()
    }
    this.live.set(ptyId, entry)
    if (o.agent === 'claude') this.parkedJobs?.register(ptyId, o.sessionId)

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
    const inputNotifications = entry.inputScanner

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
      this.live.delete(ptyId)
      this.parkedJobs?.unregister(ptyId)
      this.emit('exit', ptyId, entry.exitCode)
      this.emitActive()
    })

    const state = this.toState(entry)
    o.beforeAnnounce?.(state)
    this.emitActive()
    return state
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

  private toState(e: Live): PtySession {
    return {
      ptyId: e.ptyId,
      sessionId: e.sessionId,
      agent: e.agent,
      cwd: e.cwd,
      title: e.title,
      status: e.status,
      lastActivity: e.lastActivity,
      startedAt: e.startedAt,
      inputRequestedAt: e.inputRequestedAt,
      origin: e.origin,
      provisional: e.provisional,
      parkedJob: e.parkedJob,
      exitCode: e.exitCode
    }
  }

  private emitActive(): void {
    this.emit('active-changed', this.list())
  }
}

/**
 * Identity of one probe's INPUTS, so an unchanged state isn't probed forever. Order-independent (both
 * sides sorted), because neither the live-PTY map's iteration order nor the index's ordering is
 * meaningful — only membership is.
 */
function probeSignature(
  targets: readonly CodexPtyTarget[],
  candidates: ReadonlySet<string>
): string {
  const ptys = targets
    .map((p) => `${p.ptyId}:${p.shellPid}`)
    .sort()
    .join(',')
  return `${ptys}|${[...candidates].sort().join(',')}`
}
