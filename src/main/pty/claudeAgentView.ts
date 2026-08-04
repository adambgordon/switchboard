import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, readdirSync, watch as watchFile } from 'node:fs'
import type { FSWatcher as NodeFsWatcher } from 'node:fs'
import type { PtySurface } from '../../shared/types'

const SHORT_ID = /^[a-f0-9]{8}$/
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const REGISTRY_POLL_MS = 250

type AgentViewHostSurface = Extract<PtySurface, { kind: 'agent-view-host' }>

export interface AgentViewRegistryRecord {
  sessionId: string
  pid: number
}

export function enterClaudeAgentView(surface: PtySurface): AgentViewHostSurface {
  return surface.kind === 'agent-view-host'
    ? surface
    : { kind: 'agent-view-host', controllerSessionId: surface.sessionId }
}

export function exitClaudeAgentView(surface: PtySurface): PtySurface {
  return surface.kind === 'agent-view-host'
    ? { kind: 'conversation', sessionId: surface.controllerSessionId }
    : surface
}

/**
 * Claude writes `parkedJobId` when a session moves into Agent View and clears it on exit, so its
 * presence — not its value — is what identifies a controller. The id it holds is the job the session
 * parked into, never the agent currently on screen, so it must not be read as an attachment.
 */
export function agentViewControllerFromRegistry(text: string): AgentViewRegistryRecord | null {
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
      ? { sessionId: value.sessionId, pid: value.pid }
      : null
  } catch {
    return null
  }
}

export interface ClaudeAgentViewMonitorOptions {
  sessionsRoot?: string
  isProcessAlive?: (pid: number) => boolean
  onHost: (ptyId: string) => void
  onExit: (ptyId: string) => void
}

interface Controller {
  controllerSessionId: string
  inAgentView: boolean
}

/**
 * Watches Claude's private session registry to tell which Switchboard-owned Claude PTYs are sitting
 * in Agent View. Consumers see only enter/exit callbacks — registry records, pids, and failure policy
 * stay behind this boundary. Watching runs only while Claude PTYs exist.
 */
export class ClaudeAgentViewMonitor {
  private readonly sessionsRoot: string
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly opts: ClaudeAgentViewMonitorOptions
  private readonly controllers = new Map<string, Controller>()
  private watcher: NodeFsWatcher | null = null
  private poll: ReturnType<typeof setInterval> | null = null

  constructor(opts: ClaudeAgentViewMonitorOptions) {
    this.opts = opts
    this.sessionsRoot = opts.sessionsRoot ?? join(homedir(), '.claude', 'sessions')
    this.isProcessAlive = opts.isProcessAlive ?? defaultIsProcessAlive
  }

  register(ptyId: string, controllerSessionId: string): void {
    this.controllers.set(ptyId, { controllerSessionId, inAgentView: false })
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
    const inAgentView = new Set<string>()
    try {
      for (const entry of readdirSync(this.sessionsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        try {
          const record = agentViewControllerFromRegistry(
            readFileSync(join(this.sessionsRoot, entry.name), 'utf8')
          )
          // Claude leaves the record behind when a session dies, so a resumed conversation would
          // otherwise inherit the dead process's Agent View state.
          if (record && this.isProcessAlive(record.pid)) inAgentView.add(record.sessionId)
        } catch {
          /* one unreadable record must not hide the rest */
        }
      }
    } catch {
      // The registry is absent entirely — hold current state rather than reporting every controller
      // as having left Agent View.
      return
    }

    for (const [ptyId, controller] of this.controllers) {
      const next = inAgentView.has(controller.controllerSessionId)
      if (next === controller.inAgentView) continue
      controller.inAgentView = next
      if (next) this.opts.onHost(ptyId)
      else this.opts.onExit(ptyId)
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
