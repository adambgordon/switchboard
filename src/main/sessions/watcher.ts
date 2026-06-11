/**
 * Watches the Claude Code projects root for session-file changes and fires a
 * debounced `onChange` callback so the main process can re-index.
 *
 * Pure Node — no Electron, no DOM. Backed by chokidar v3.
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'

export interface SessionWatcherOptions {
  /** Projects root to watch. Defaults to `~/.claude/projects`. */
  projectsRoot?: string
  /** Called (debounced) whenever a session file is added, changed, or removed. */
  onChange: () => void
  /** Debounce window in ms for coalescing bursts of fs events. Default 400. */
  debounceMs?: number
}

/** Default projects root: `~/.claude/projects`. */
function defaultProjectsRoot(): string {
  return path.join(homedir(), '.claude', 'projects')
}

/**
 * Watches `<root>/**\/*.jsonl` for add/change/unlink and invokes a debounced
 * `onChange`. `start()` is idempotent; `stop()` tears the watcher down and is
 * safe to call when not started. Construction/start never throw if the root
 * does not yet exist (chokidar tolerates a missing path).
 */
export class SessionWatcher {
  private readonly root: string
  private readonly onChange: () => void
  private readonly debounceMs: number

  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SessionWatcherOptions) {
    this.root = opts.projectsRoot ?? defaultProjectsRoot()
    this.onChange = opts.onChange
    this.debounceMs = opts.debounceMs ?? 400
  }

  /** Begin watching. No-op if already started. */
  start(): void {
    if (this.watcher) return

    const glob = path.join(this.root, '**', '*.jsonl')
    const watcher = watch(glob, {
      ignoreInitial: true,
      // Wait for writes to settle so we read complete lines, not partial flushes.
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    })

    const handler = (): void => this.schedule()
    watcher.on('add', handler)
    watcher.on('change', handler)
    watcher.on('unlink', handler)
    // Swallow watcher errors (e.g. transient EPERM) rather than crashing.
    watcher.on('error', () => {})

    this.watcher = watcher
  }

  /** Stop watching and cancel any pending debounced callback. No-op if stopped. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      void this.watcher.close()
      this.watcher = null
    }
  }

  /** (Re)arm the debounce timer; fires `onChange` once the burst settles. */
  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.onChange()
    }, this.debounceMs)
  }
}
