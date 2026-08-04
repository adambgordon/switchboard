import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch as watchFile,
  writeFileSync
} from 'node:fs'
import type { FSWatcher as NodeFsWatcher } from 'node:fs'
import { readFile, stat, truncate } from 'node:fs/promises'
import type { PtySurface } from '../../shared/types'

const SHORT_ID = /^[a-f0-9]{8}$/
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const DEBUG_FILE_MAX_BYTES = 128 * 1024
const DEBUG_LINE_MAX_BYTES = 8 * 1024
const STALE_RUN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ATTACH_RESOLVE_ATTEMPTS = 10
const ATTACH_RESOLVE_RETRY_MS = 100
const DEBUG_POLL_MS = 100
const REGISTRY_POLL_MS = 250

const ATTACH_LINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[DEBUG\] \[FV-attach\] respawnJob ([a-f0-9]+): ok=(true|false) alive=(true|false) err=(.*)\r?$/
const DETACH_LINE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[DEBUG\] \[FV-attach\] attachJob returned after (\d+)ms — remounting list\r?$/

export type ClaudeAttachLogEvent =
  | { kind: 'attach'; shortId: string }
  | { kind: 'attach-failed' }
  | { kind: 'detach' }
  | { kind: 'unexpected' }
type ClaudeLifecycleLogEvent = Exclude<ClaudeAttachLogEvent, { kind: 'unexpected' }>

export interface ResolvedClaudeJob {
  sessionId: string
  cwd: string
  title: string
}

type AgentViewHostSurface = Extract<PtySurface, { kind: 'agent-view-host' }>

export function enterClaudeAgentView(surface: PtySurface): AgentViewHostSurface {
  return surface.kind === 'agent-view-host'
    ? surface
    : { kind: 'agent-view-host', controllerSessionId: surface.sessionId }
}

export function attachClaudeAgentView(surface: PtySurface, sessionId: string): PtySurface {
  const host = enterClaudeAgentView(surface)
  return host.attachedSessionId === sessionId ? host : { ...host, attachedSessionId: sessionId }
}

export function detachClaudeAgentView(surface: PtySurface): PtySurface {
  return surface.kind === 'agent-view-host' && surface.attachedSessionId != null
    ? { kind: 'agent-view-host', controllerSessionId: surface.controllerSessionId }
    : surface
}

export function splitClaudeDebugChunk(
  remainder: string,
  chunk: string
): { lines: string[]; remainder: string } {
  const lines = (remainder + chunk).split('\n')
  return { lines, remainder: lines.pop() ?? '' }
}

interface ControllerMonitor {
  controllerSessionId: string
  debugFile: string | null
  debugWatcher: NodeFsWatcher | null
  debugPoll: ReturnType<typeof setInterval> | null
  offset: number
  remainder: string
  disabled: boolean
  hostKnown: boolean
  pendingEvent: ClaudeLifecycleLogEvent | null
  generation: number
  retryTimer: ReturnType<typeof setTimeout> | null
  retryWake: (() => void) | null
  readChain: Promise<void>
}

export interface ClaudeAgentViewMonitorOptions {
  debugRoot: string
  sessionsRoot?: string
  jobsRoot?: string
  hasTranscript: (sessionId: string) => Promise<boolean>
  onHost: (ptyId: string) => void
  onAttach: (ptyId: string, session: ResolvedClaudeJob) => void
  onDetach: (ptyId: string) => void
}

/** Parse one filtered Claude debug line. Any non-empty unknown line is a fail-closed boundary. */
export function parseClaudeAttachLogLine(line: string): ClaudeAttachLogEvent | null {
  if (!line) return null
  const attach = ATTACH_LINE.exec(line)
  if (attach) {
    const shortId = attach[1]
    if (!SHORT_ID.test(shortId)) return { kind: 'unexpected' }
    return attach[2] === 'true' || attach[3] === 'true'
      ? { kind: 'attach', shortId }
      : { kind: 'attach-failed' }
  }
  if (DETACH_LINE.test(line)) return { kind: 'detach' }
  return { kind: 'unexpected' }
}

/** Return the exact controller id only when a structured live-session record proves Agent View. */
export function agentViewControllerFromRegistry(text: string): string | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    return value.kind === 'interactive' &&
      typeof value.sessionId === 'string' &&
      SESSION_ID.test(value.sessionId) &&
      typeof value.parkedJobId === 'string' &&
      SHORT_ID.test(value.parkedJobId)
      ? value.sessionId
      : null
  } catch {
    return null
  }
}

/** Resolve an untrusted private job record into a conversation only after every identity check. */
export async function resolveClaudeAttachedJob(
  shortId: string,
  jobsRoot: string,
  hasTranscript: (sessionId: string) => Promise<boolean>
): Promise<ResolvedClaudeJob | null> {
  if (!SHORT_ID.test(shortId)) return null
  try {
    const text = await readFile(join(jobsRoot, shortId, 'state.json'), 'utf8')
    const value = JSON.parse(text) as Record<string, unknown>
    if (value.daemonShort !== shortId) return null
    if (typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)) return null
    if (!value.sessionId.startsWith(`${shortId}-`)) return null
    if (typeof value.cwd !== 'string' || !value.cwd) return null
    if (!(await hasTranscript(value.sessionId))) return null
    const title =
      typeof value.name === 'string' && value.name.trim()
        ? value.name.trim()
        : typeof value.detail === 'string' && value.detail.trim()
          ? value.detail.trim()
          : 'Conversation'
    return { sessionId: value.sessionId, cwd: value.cwd, title }
  } catch {
    return null
  }
}

/**
 * Owns Claude's private Agent View inputs. Consumers see only host/attach/detach callbacks; registry
 * records, debug text, short ids, races, and failure policy stay inside this boundary.
 */
export class ClaudeAgentViewMonitor {
  private readonly sessionsRoot: string
  private readonly jobsRoot: string
  private readonly runDir: string
  private readonly opts: ClaudeAgentViewMonitorOptions
  private readonly controllers = new Map<string, ControllerMonitor>()
  private readonly registryControllers = new Map<string, string>()
  private readonly registryWatcher: NodeFsWatcher | null
  private readonly registryPoll: ReturnType<typeof setInterval>

  constructor(opts: ClaudeAgentViewMonitorOptions) {
    this.opts = opts
    this.sessionsRoot = opts.sessionsRoot ?? join(homedir(), '.claude', 'sessions')
    this.jobsRoot = opts.jobsRoot ?? join(homedir(), '.claude', 'jobs')
    mkdirSync(opts.debugRoot, { recursive: true, mode: 0o700 })
    this.cleanStaleRuns(opts.debugRoot)
    this.runDir = join(opts.debugRoot, `run-${process.pid}-${randomUUID()}`)
    mkdirSync(this.runDir, { recursive: true, mode: 0o700 })

    this.refreshRegistryFiles()
    let registryWatcher: NodeFsWatcher | null = null
    try {
      registryWatcher = watchFile(this.sessionsRoot, (_eventType, filename) => {
        if (!filename) {
          this.refreshRegistryFiles()
          return
        }
        const filePath = join(this.sessionsRoot, String(filename))
        if (!filePath.endsWith('.json')) return
        // Re-scan synchronously so an old async read can never establish proof after unlink/replace.
        this.refreshRegistryFiles()
      })
      registryWatcher.on('error', () => {})
    } catch {
      /* Claude's registry directory may not exist yet; registration still re-scans synchronously. */
    }
    this.registryWatcher = registryWatcher
    this.registryPoll = setInterval(() => this.refreshRegistryFiles(), REGISTRY_POLL_MS)
    this.registryPoll.unref()
  }

  /** Register a Claude PTY and return its private debug-file path when enrichment is available. */
  register(ptyId: string, controllerSessionId: string): string | undefined {
    let debugFile: string | null = join(this.runDir, `${ptyId}.log`)
    let debugWatcher: NodeFsWatcher | null = null
    try {
      writeFileSync(debugFile, '', { mode: 0o600, flag: 'wx' })
    } catch {
      debugFile = null
    }
    if (debugFile) {
      try {
        debugWatcher = watchFile(debugFile)
      } catch {
        /* polling below is the reliable backstop when native watch handles are unavailable */
      }
    }

    const controller: ControllerMonitor = {
      controllerSessionId,
      debugFile,
      debugWatcher,
      debugPoll: null,
      offset: 0,
      remainder: '',
      disabled: debugFile == null,
      hostKnown: this.hasRegistryProof(controllerSessionId),
      pendingEvent: null,
      generation: 0,
      retryTimer: null,
      retryWake: null,
      readChain: Promise.resolve()
    }
    this.controllers.set(ptyId, controller)
    if (controller.hostKnown) this.opts.onHost(ptyId)

    if (debugWatcher) {
      debugWatcher.on('change', (eventType) => {
        if (eventType === 'rename') this.disable(ptyId)
        else this.scheduleRead(ptyId)
      })
      debugWatcher.on('error', () => {
        // A process can exhaust native watch handles; polling below remains authoritative.
        try {
          debugWatcher.close()
        } catch {
          /* already closed */
        }
        controller.debugWatcher = null
      })
    }
    if (debugFile) {
      // fs.watch is advisory and can miss an append during watcher initialization. A cheap stat/read
      // backstop keeps the per-PTY protocol reliable without making polling the primary signal.
      controller.debugPoll = setInterval(() => this.scheduleRead(ptyId), DEBUG_POLL_MS)
      controller.debugPoll.unref()
      this.scheduleRead(ptyId)
    }
    return debugFile ?? undefined
  }

  unregister(ptyId: string): void {
    const controller = this.controllers.get(ptyId)
    if (!controller) return
    this.controllers.delete(ptyId)
    this.cancelRetry(controller)
    controller.generation++
    if (controller.debugPoll) clearInterval(controller.debugPoll)
    try {
      controller.debugWatcher?.close()
    } catch {
      /* debug cleanup must never escape the PTY exit path */
    }
    try {
      if (controller.debugFile) rmSync(controller.debugFile, { force: true })
    } catch {
      /* app-owned temp cleanup is best-effort */
    }
  }

  dispose(): void {
    for (const ptyId of [...this.controllers.keys()]) this.unregister(ptyId)
    clearInterval(this.registryPoll)
    try {
      this.registryWatcher?.close()
    } catch {
      /* app-owned watcher cleanup is best-effort */
    }
    try {
      rmSync(this.runDir, { recursive: true, force: true })
    } catch {
      /* app-owned temp cleanup is best-effort */
    }
  }

  private hasRegistryProof(controllerSessionId: string): boolean {
    this.refreshRegistryFiles()
    return [...this.registryControllers.values()].some((id) => id === controllerSessionId)
  }

  private refreshRegistryFiles(): void {
    const present = new Set<string>()
    try {
      for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const filePath = join(this.sessionsRoot, entry.name)
        present.add(filePath)
        try {
          const controllerSessionId = agentViewControllerFromRegistry(readFileSync(filePath, 'utf8'))
          if (controllerSessionId) this.acceptRegistryProof(filePath, controllerSessionId)
          else this.registryControllers.delete(filePath)
        } catch {
          this.registryControllers.delete(filePath)
        }
      }
      for (const filePath of this.registryControllers.keys()) {
        if (!present.has(filePath)) this.registryControllers.delete(filePath)
      }
    } catch {
      /* registry may not exist yet; a later register or directory event retries */
    }
  }

  private acceptRegistryProof(filePath: string, controllerSessionId: string): void {
    this.registryControllers.set(filePath, controllerSessionId)
    for (const [ptyId, controller] of this.controllers) {
      if (controller.controllerSessionId !== controllerSessionId || controller.hostKnown) continue
      controller.hostKnown = true
      this.opts.onHost(ptyId)
      const pending = controller.pendingEvent
      controller.pendingEvent = null
      if (pending && !controller.disabled) this.applyDebugEvent(ptyId, controller, pending)
    }
  }

  private scheduleRead(ptyId: string): void {
    const controller = this.controllers.get(ptyId)
    if (!controller || !controller.debugFile) return
    controller.readChain = controller.readChain.then(() => this.readDebug(ptyId)).catch(() => {
      this.disable(ptyId)
    })
  }

  private async readDebug(ptyId: string): Promise<void> {
    const controller = this.controllers.get(ptyId)
    if (!controller?.debugFile) return
    const info = await stat(controller.debugFile)
    if (info.size > DEBUG_FILE_MAX_BYTES) {
      await truncate(controller.debugFile, 0)
      controller.offset = 0
      controller.remainder = ''
      this.disable(ptyId)
      return
    }
    if (controller.disabled || info.size === controller.offset) return
    const data = await readFile(controller.debugFile)
    if (data.length < controller.offset) {
      controller.offset = 0
      controller.remainder = ''
    }
    const chunk = data.subarray(controller.offset).toString('utf8')
    controller.offset = data.length
    const split = splitClaudeDebugChunk(controller.remainder, chunk)
    const lines = split.lines
    controller.remainder = split.remainder
    if (Buffer.byteLength(controller.remainder) > DEBUG_LINE_MAX_BYTES) {
      this.disable(ptyId)
      return
    }
    for (const line of lines) {
      if (!this.handleDebugEvent(ptyId, parseClaudeAttachLogLine(line))) return
    }
  }

  private handleDebugEvent(ptyId: string, event: ClaudeAttachLogEvent | null): boolean {
    if (!event) return true
    const controller = this.controllers.get(ptyId)
    if (!controller || controller.disabled) return false
    if (event.kind === 'unexpected') {
      this.disable(ptyId)
      return false
    }
    if (!controller.hostKnown) {
      // The filtered debug line is attachment lifecycle, not controller identity. Hold only the
      // latest state transition until the exact interactive registry record proves this PTY's host.
      controller.pendingEvent = event
      return true
    }

    this.applyDebugEvent(ptyId, controller, event)
    return true
  }

  private applyDebugEvent(
    ptyId: string,
    controller: ControllerMonitor,
    event: ClaudeLifecycleLogEvent
  ): void {
    this.cancelRetry(controller)
    controller.generation++
    const generation = controller.generation
    this.opts.onHost(ptyId)
    this.opts.onDetach(ptyId)
    if (event.kind !== 'attach') return

    void this.resolveAttachment(ptyId, controller, generation, event.shortId)
  }

  private async resolveAttachment(
    ptyId: string,
    controller: ControllerMonitor,
    generation: number,
    shortId: string
  ): Promise<void> {
    for (let attempt = 0; attempt < ATTACH_RESOLVE_ATTEMPTS; attempt++) {
      const beforeResolve = this.controllers.get(ptyId)
      if (
        beforeResolve !== controller ||
        beforeResolve.disabled ||
        beforeResolve.generation !== generation
      ) {
        return
      }
      const session = await resolveClaudeAttachedJob(shortId, this.jobsRoot, this.opts.hasTranscript)
      const current = this.controllers.get(ptyId)
      if (current !== controller || current.disabled || current.generation !== generation) return
      if (session) {
        this.opts.onAttach(ptyId, session)
        return
      }
      if (attempt < ATTACH_RESOLVE_ATTEMPTS - 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (controller.retryTimer === timer) {
              controller.retryTimer = null
              controller.retryWake = null
            }
            resolve()
          }, ATTACH_RESOLVE_RETRY_MS)
          timer.unref()
          controller.retryTimer = timer
          controller.retryWake = resolve
        })
      }
    }
  }

  private disable(ptyId: string): void {
    const controller = this.controllers.get(ptyId)
    if (!controller || controller.disabled) return
    controller.disabled = true
    controller.pendingEvent = null
    this.cancelRetry(controller)
    controller.generation++
    if (controller.debugPoll) {
      clearInterval(controller.debugPoll)
      controller.debugPoll = null
    }
    if (controller.hostKnown) {
      this.opts.onHost(ptyId)
      this.opts.onDetach(ptyId)
    }
  }

  private cleanStaleRuns(debugRoot: string): void {
    const now = Date.now()
    try {
      for (const entry of readdirSync(debugRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue
        const path = join(debugRoot, entry.name)
        try {
          if (now - statSync(path).mtimeMs <= STALE_RUN_MAX_AGE_MS) continue
          const owner = /^run-(\d+)-/.exec(entry.name)
          if (owner && this.isProcessAlive(Number(owner[1]))) continue
          rmSync(path, { recursive: true, force: true })
        } catch {
          /* cleanup of one run must not prevent checking the rest */
        }
      }
    } catch {
      /* cleanup is best-effort */
    }
  }

  private cancelRetry(controller: ControllerMonitor): void {
    if (controller.retryTimer) clearTimeout(controller.retryTimer)
    controller.retryTimer = null
    const wake = controller.retryWake
    controller.retryWake = null
    wake?.()
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}
