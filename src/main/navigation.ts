import type { TabOpenMode } from '../shared/types'
import type { NavigationCommand, NavigationVisit } from '../shared/navigation'
import { EMPTY_HISTORY, historyReducer, type NavigationHistory } from './navigationHistory'

export interface NavigationHost {
  ownerOf(sessionId: string): number | undefined
  exists(windowId: number): boolean
  activate(windowId: number, command: NavigationCommand): void
  cancel(windowId: number, requestId: number): void
  focus(windowId: number): void
  restoreTerminal(windowId: number, sessionId: string, current: () => boolean): Promise<boolean>
}

interface PendingNavigation {
  command: NavigationCommand
  requester: number
  target: number
  retried: boolean
  preparing: boolean
  sent: boolean
  focusing: boolean
}

/** Main owns the cursor and native focus; window snapshots are routing data, not separate histories. */
export class NavigationCoordinator {
  private history: NavigationHistory = EMPTY_HISTORY
  private readonly windows = new Map<number, NavigationVisit | null>()
  private readonly revisions = new Map<number, number>()
  private activeWindow: number | null = null
  private pending: PendingNavigation | null = null
  private nextRequest = 0
  private hiddenSessionIds: ReadonlySet<string> = new Set()
  /**
   * Ids that were once a legitimate destination and now name nothing: the placeholder of a new
   * agent terminal that was stopped before it ever proved which conversation it held. Distinct from
   * hidden sessions, which name a real conversation deliberately kept out of sight — but both are
   * unreachable, so both are stepped over rather than deleted from history. Process-lifetime, like
   * the hidden set; the population is one id per new terminal that never bound.
   */
  private readonly retiredSessionIds = new Set<string>()

  constructor(private readonly host: NavigationHost) {}

  get state(): NavigationHistory {
    return this.history
  }

  /** A stop on this id can no longer be shown, whatever the reason. */
  private unreachable(sessionId: string): boolean {
    return this.hiddenSessionIds.has(sessionId) || this.retiredSessionIds.has(sessionId)
  }

  private forget(matches: (sessionId: string) => boolean): void {
    if (this.pending && matches(this.pending.command.sessionId)) this.interrupt()
    for (const [windowId, visit] of this.windows) {
      if (visit && matches(visit.sessionId)) this.windows.set(windowId, null)
    }
  }

  setHiddenSessions(ids: ReadonlySet<string>): void {
    this.hiddenSessionIds = ids
    this.forget((sessionId) => ids.has(sessionId))
  }

  /**
   * A terminal was stopped without ever having been matched to a conversation, so its id is now a
   * dead end. History keeps the stop — deleting entries would shift the cursor under the user — and
   * Back/Forward step past it to the next reachable one.
   */
  retire(sessionId: string): void {
    this.retiredSessionIds.add(sessionId)
    this.forget((id) => id === sessionId)
  }

  private record(visit: NavigationVisit | null): void {
    this.history = historyReducer(this.history, visit ? { type: 'visit', visit } : { type: 'home' })
  }

  report(windowId: number, visit: NavigationVisit | null, record: boolean, revision = 0): void {
    if (visit && this.unreachable(visit.sessionId)) return
    const first = !this.windows.has(windowId)
    this.windows.set(windowId, visit)
    this.revisions.set(windowId, revision)
    const pending = this.pending
    if (pending) {
      if (pending.target === windowId && !pending.sent) void this.prepare(pending)
      return
    }
    if (this.activeWindow === windowId && (record || first)) this.record(visit)
  }

  focused(windowId: number): void {
    const pending = this.pending
    const changed = this.activeWindow !== windowId
    this.activeWindow = windowId
    if (pending?.focusing && pending.target === windowId) {
      this.pending = null
      return
    }
    // A booting destination has no alternative visit to record when its first window show focuses it.
    if (pending?.target === windowId && !this.windows.has(windowId)) return
    if (!changed) return
    this.interrupt()
    if (this.windows.has(windowId)) this.record(this.windows.get(windowId) ?? null)
  }

  /** A genuine local navigation supersedes playback even if its selected id stays unchanged. */
  interrupt(): void {
    const pending = this.pending
    this.pending = null
    if (pending) this.host.cancel(pending.target, pending.command.requestId)
  }

  intent(windowId: number, revision: number): void {
    this.revisions.set(windowId, revision)
    this.interrupt()
  }

  go(requester: number, direction: -1 | 1): void {
    let state = this.history
    for (let attempts = 0; attempts <= state.entries.length; attempts += 1) {
      const next = historyReducer(state, { type: 'step', direction })
      if (next === state) return
      const visit = next.entries[next.cursor]
      if (!this.unreachable(visit.sessionId)) {
        this.history = next
        this.start(requester, visit.sessionId, 'preview', visit.view, 'replay')
        return
      }
      state = next
    }
  }

  reveal(requester: number, sessionId: string, mode: TabOpenMode): void {
    this.start(requester, sessionId, mode, null, 'visit')
  }

  private start(
    requester: number,
    sessionId: string,
    mode: TabOpenMode,
    view: NavigationVisit['view'] | null,
    kind: NavigationCommand['kind']
  ): void {
    if (this.unreachable(sessionId)) return
    this.interrupt()
    const owner = this.host.ownerOf(sessionId)
    const target = owner != null && this.host.exists(owner) ? owner : requester
    if (!this.host.exists(target)) return
    const pending: PendingNavigation = {
      command: { requestId: ++this.nextRequest, targetRevision: this.revisions.get(target) ?? 0, sessionId, mode, view, kind },
      requester, target, retried: false, preparing: false, sent: false, focusing: false
    }
    this.pending = pending
    void this.prepare(pending)
  }

  private async prepare(pending: PendingNavigation): Promise<void> {
    if (this.pending !== pending || pending.preparing || pending.sent || !this.windows.has(pending.target)) return
    pending.preparing = true
    const current = (): boolean => this.pending === pending && this.host.exists(pending.target)
    if (pending.command.view === 'terminal') {
      let restored = false
      try {
        restored = await this.host.restoreTerminal(pending.target, pending.command.sessionId, current)
      } catch {
        // History can still reveal the transcript when a terminal is no longer available.
      }
      if (!current()) return
      if (!restored) pending.command = { ...pending.command, view: 'transcript' }
    }
    if (!current()) return
    pending.sent = true
    pending.command = { ...pending.command, targetRevision: this.revisions.get(pending.target) ?? 0 }
    this.host.activate(pending.target, pending.command)
  }

  complete(windowId: number, requestId: number, visit: NavigationVisit | null): void {
    const pending = this.pending
    if (!pending || pending.focusing || pending.target !== windowId || pending.command.requestId !== requestId) return
    const owner = this.host.ownerOf(pending.command.sessionId)
    if (!visit || visit.sessionId !== pending.command.sessionId ||
      (owner != null && owner !== windowId && this.host.exists(owner))) {
      this.retry(pending)
      return
    }
    this.windows.set(windowId, visit)
    if (pending.command.kind === 'visit') this.record(visit)
    // A fallback to Formatted does not rewrite the historical Terminal visit or truncate Forward.
    pending.focusing = true
    if (this.activeWindow === windowId) this.pending = null
    this.host.focus(windowId)
  }

  private retry(pending: PendingNavigation): void {
    this.host.cancel(pending.target, pending.command.requestId)
    if (pending.retried) {
      this.pending = null
      return
    }
    const owner = this.host.ownerOf(pending.command.sessionId)
    const target = owner != null && this.host.exists(owner) ? owner : pending.requester
    if (!this.host.exists(target)) {
      this.pending = null
      return
    }
    this.pending = {
      ...pending,
      command: { ...pending.command, requestId: ++this.nextRequest },
      target, retried: true, preparing: false, sent: false, focusing: false
    }
    void this.prepare(this.pending)
  }

  closed(windowId: number): void {
    this.windows.delete(windowId)
    this.revisions.delete(windowId)
    if (this.activeWindow === windowId) this.activeWindow = null
    if (this.pending?.target === windowId) this.retry(this.pending)
  }

  rekey(from: string, to: string): void {
    this.history = historyReducer(this.history, { type: 'rekey', from, to })
    for (const [windowId, visit] of this.windows) {
      if (visit?.sessionId === from) this.windows.set(windowId, { ...visit, sessionId: to })
    }
    if (this.pending?.command.sessionId === from) {
      this.pending.command = { ...this.pending.command, sessionId: to }
      if (this.pending.preparing && !this.pending.sent) {
        const { requester, command } = this.pending
        this.start(requester, to, command.mode, command.view, command.kind)
      }
    }
  }

  retarget(windowId: number, from: string, to: string): void {
    const visit = this.windows.get(windowId)
    if (visit?.sessionId !== from) return
    this.windows.set(windowId, { ...visit, sessionId: to })
    if (this.activeWindow === windowId) {
      this.history = historyReducer(this.history, { type: 'retarget', from, to })
    }
  }
}
