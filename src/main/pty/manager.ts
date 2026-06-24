import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { CONFIG, type AgentKind, type PtyState, type PtyStatus } from '../../shared/types'

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
  idleTimer: ReturnType<typeof setTimeout> | null
  bootTimer: ReturnType<typeof setTimeout> | null
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

/**
 * Owns every live PTY-backed claude session.
 *
 * Design notes:
 * - We spawn the user's LOGIN + INTERACTIVE shell as the PTY program, then type the
 *   `claude` command into it. A GUI Electron app inherits a minimal PATH (no
 *   ~/.local/bin, no Homebrew), so invoking `claude` directly would fail with
 *   ENOENT. A login shell sources the user's profile and gets the real PATH — and
 *   it gives a genuine terminal: when claude exits, you're back at a prompt.
 * - Busy vs idle is inferred from output activity (debounced). It does NOT drive the
 *   liveness dot (a live claude TUI repaints constantly — every keystroke echoes as output —
 *   so a PTY is ~always "busy"; the transcript turn-state drives the dot, see parser.ts /
 *   App.tsx). Here it ONLY gates LRU eviction (we never kill busy work).
 */
export class PtyManager extends EventEmitter {
  private live = new Map<string, Live>()
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

  resume(sessionId: string, cwd: string, title = 'Conversation'): PtyState {
    // Phase 1 spawns only Claude (Codex resume lands in Phase 2). agent is threaded through so the
    // rest of the plumbing (PtyState.agent, the boot command) is already agent-aware.
    return this.spawn({ sessionId, cwd, title, origin: 'resume', agent: 'claude' })
  }

  startNew(cwd: string): PtyState {
    return this.spawn({
      sessionId: randomUUID(),
      cwd,
      title: 'New conversation',
      origin: 'new',
      agent: 'claude'
    })
  }

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
  }

  list(): PtyState[] {
    return [...this.live.values()].map((e) => this.toState(e))
  }

  /** Find a live PTY already driving a session, if any. */
  findBySession(sessionId: string): PtyState | null {
    for (const e of this.live.values()) {
      if (e.sessionId === sessionId) return this.toState(e)
    }
    return null
  }

  private spawn(o: {
    sessionId: string
    cwd: string
    title: string
    origin: 'resume' | 'new'
    agent: AgentKind
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
        ...process.env,
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
      idleTimer: null,
      bootTimer: null,
      booted: false,
      shellReady: false,
      sized: false,
      bootWhenReady: () => {},
      exitCode: null
    }
    this.live.set(ptyId, entry)

    const bootCmd =
      o.origin === 'resume'
        ? `claude --resume ${o.sessionId}`
        : `claude --session-id ${o.sessionId}`

    const boot = (): void => {
      if (entry.booted) return
      entry.booted = true
      if (entry.bootTimer) clearTimeout(entry.bootTimer)
      // \r submits the line in the interactive shell.
      proc.write(`${bootCmd}\r`)
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

    proc.onData((data) => {
      if (!entry.shellReady) {
        entry.shellReady = true
        bootWhenReady()
      }
      entry.lastActivity = Date.now()
      this.markBusy(entry)
      this.emit('data', ptyId, data)
    })

    proc.onExit(({ exitCode }) => {
      entry.status = 'exited'
      entry.exitCode = exitCode ?? 0
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      if (entry.bootTimer) clearTimeout(entry.bootTimer)
      this.live.delete(ptyId)
      this.emit('exit', ptyId, entry.exitCode)
      this.emitActive()
    })

    this.emitActive()
    return this.toState(entry)
  }

  private markBusy(e: Live): void {
    const wasBusy = e.status === 'busy'
    e.status = 'busy'
    if (e.idleTimer) clearTimeout(e.idleTimer)
    e.idleTimer = setTimeout(() => {
      if (e.status === 'exited') return
      e.status = 'idle'
      this.emitActive()
    }, CONFIG.busyWindowMs)
    if (!wasBusy) this.emitActive()
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
      sessionId: e.sessionId,
      agent: e.agent,
      cwd: e.cwd,
      title: e.title,
      status: e.status,
      lastActivity: e.lastActivity,
      startedAt: e.startedAt,
      origin: e.origin,
      exitCode: e.exitCode
    }
  }

  private emitActive(): void {
    this.emit('active-changed', this.list())
  }
}
