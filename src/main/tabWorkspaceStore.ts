import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PersistedTabLayout } from '../shared/types'
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

export class TabWorkspaceStore {
  private readonly windows = new Map<number, PersistedTabLayout>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly dir: string,
    private readonly file = FILE
  ) {}

  register(windowId: number, layout: unknown): void {
    const valid = sanitizeTabLayout(layout)
    if (valid) this.windows.set(windowId, valid)
  }

  update(windowId: number, layout: unknown): void {
    const valid = layout ? sanitizeTabLayout(layout) : null
    if (valid) this.windows.set(windowId, valid)
    else this.windows.delete(windowId)
    this.schedule()
  }

  remove(windowId: number): void {
    if (!this.windows.delete(windowId)) return
    this.schedule()
  }

  close(windowId: number, preserve: boolean): void {
    if (!preserve) this.remove(windowId)
  }

  snapshot(): PersistedTabLayout[] {
    return sanitizeTabWorkspace({
      version: TAB_WORKSPACE_VERSION,
      windows: [...this.windows.values()]
    }).windows
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    try {
      writeFileSync(join(this.dir, this.file), JSON.stringify({
        version: TAB_WORKSPACE_VERSION,
        windows: this.snapshot()
      }))
    } catch {
      /* tab restoration is best-effort */
    }
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
  }
}
