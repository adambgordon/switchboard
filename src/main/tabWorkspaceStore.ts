import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedTabLayout } from '../shared/types'
import { visibleTabLayout } from '../shared/sessionVisibility'
import {
  sanitizeTabLayout,
  sanitizeTabWorkspace,
  TAB_WORKSPACE_VERSION
} from '../shared/tabWorkspace'

const FILE = 'tab-workspace.json'
const SAVE_DELAY_MS = 100

export function loadTabWorkspace(dir: string, file = FILE): PersistedTabLayout[] {
  try {
    return sanitizeTabWorkspace(JSON.parse(readFileSync(join(dir, file), 'utf8'))).windows
  } catch {
    return []
  }
}

export function writeTabWorkspaceFile(path: string, contents: string): boolean {
  const temporary = `${path}.tmp`
  try {
    writeFileSync(temporary, contents)
    renameSync(temporary, path)
    return true
  } catch {
    try {
      unlinkSync(temporary)
    } catch {
      /* best-effort cleanup; the previous workspace remains authoritative */
    }
    return false
  }
}

export class TabWorkspaceStore {
  private readonly windows = new Map<number, PersistedTabLayout>()
  private dormant: PersistedTabLayout[]
  private timer: ReturnType<typeof setTimeout> | null = null
  private hiddenSessionIds: ReadonlySet<string> = new Set()

  constructor(
    private readonly dir: string,
    private readonly file = FILE,
    restored: PersistedTabLayout[] = [],
    private readonly ownerForSession: (sessionId: string) => number | undefined = () => undefined
  ) {
    this.dormant = sanitizeTabWorkspace({
      version: TAB_WORKSPACE_VERSION,
      windows: restored
    }).windows
  }

  /** Reserve the first saved layout for the primary window; the rest stay dormant until activated. */
  takePrimary(): PersistedTabLayout | null {
    return this.dormant.shift() ?? null
  }

  layoutFor(windowId: number): PersistedTabLayout | null {
    return this.windows.get(windowId) ?? null
  }

  takeDormant(): PersistedTabLayout[] {
    const layouts = this.dormant
    this.dormant = []
    return layouts
  }

  register(windowId: number, layout: unknown): void {
    const valid = visibleTabLayout(sanitizeTabLayout(layout), this.hiddenSessionIds)
    if (valid) this.windows.set(windowId, valid)
    else this.windows.delete(windowId)
  }

  update(windowId: number, layout: unknown): void {
    const valid = visibleTabLayout(sanitizeTabLayout(layout), this.hiddenSessionIds)
    if (valid) this.windows.set(windowId, valid)
    else this.windows.delete(windowId)
    this.schedule()
  }

  excludeSessions(ids: ReadonlySet<string>): void {
    const before = JSON.stringify(this.snapshot())
    this.hiddenSessionIds = ids
    for (const [windowId, layout] of this.windows) this.register(windowId, layout)
    this.dormant = this.dormant.flatMap((layout) => {
      const visible = visibleTabLayout(layout, ids)
      return visible ? [visible] : []
    })
    if (JSON.stringify(this.snapshot()) !== before) this.schedule()
  }

  remove(windowId: number): void {
    if (!this.windows.delete(windowId)) return
    this.schedule()
  }

  close(windowId: number, preserve: boolean): void {
    if (!preserve) this.remove(windowId)
  }

  clear(): void {
    this.windows.clear()
    this.dormant = []
    this.flush()
  }

  snapshot(): PersistedTabLayout[] {
    const entries = [...this.windows.entries()]
    const occurrences = new Map<string, Set<number>>()
    for (const [windowId, layout] of entries) {
      for (const pane of layout.panes) {
        for (const sessionId of pane.sessionIds) {
          const windows = occurrences.get(sessionId) ?? new Set<number>()
          windows.add(windowId)
          occurrences.set(sessionId, windows)
        }
      }
    }
    const active = entries.map(([windowId, layout]) => ({
      panes: layout.panes.map((pane) => ({
        ...pane,
        sessionIds: pane.sessionIds.filter((sessionId) => {
          const ownerId = this.ownerForSession(sessionId)
          const recorded = occurrences.get(sessionId)
          return ownerId == null || !recorded?.has(ownerId) || ownerId === windowId
        })
      }))
    }))
    return sanitizeTabWorkspace({
      version: TAB_WORKSPACE_VERSION,
      windows: [...active, ...this.dormant]
    }).windows
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    writeTabWorkspaceFile(
      join(this.dir, this.file),
      JSON.stringify({
        version: TAB_WORKSPACE_VERSION,
        windows: this.snapshot()
      })
    )
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
  }
}
