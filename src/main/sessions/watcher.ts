/**
 * Watches both agents' session roots — Claude Code `~/.claude/projects` and Codex
 * `~/.codex/sessions` — for session-file changes and fires a debounced `onChange` so the main
 * process can re-index.
 *
 * Pure Node — no Electron, no DOM. Backed by chokidar v3.
 *
 * NOTE on live turn-state: this watcher reliably catches structural changes (a new conversation,
 * a rename, a session in another window) but is NOT the signal that drives the live "working" dot.
 * Codex flushes its rollout to disk lazily and clusters writes around turn boundaries, so a
 * file-change event often only arrives once the turn is already complete — the open `in_progress`
 * state is on disk between flushes but isn't always announced as an event. Live turn-state is
 * instead driven by a busy-gated periodic re-index in ipc.ts (see `registerIpc`). This watcher
 * keeps `awaitWriteFinish` so it reads complete lines for the structural-change path.
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { defaultCodexRoot } from './codexParser'

export interface SessionWatcherOptions {
  /** Claude Code projects root to watch. Defaults to `~/.claude/projects`. */
  projectsRoot?: string
  /** Codex sessions root to watch. Defaults to `~/.codex/sessions`. */
  codexRoot?: string
  /** Called (debounced) whenever a session file is added, changed, or removed. */
  onChange: () => void
  /** Debounce window in ms for coalescing bursts of fs events. Default 400. */
  debounceMs?: number
}

/** Default Claude Code projects root: `~/.claude/projects`. */
function defaultProjectsRoot(): string {
  return path.join(homedir(), '.claude', 'projects')
}

/**
 * Watches both roots' `**\/*.jsonl` for add/change/unlink and invokes a debounced `onChange`.
 * `start()` is idempotent; `stop()` tears the watcher down and is safe to call when not started.
 * Construction/start never throw if a root does not yet exist (chokidar tolerates a missing path).
 */
export class SessionWatcher {
  private readonly claudeRoot: string
  private readonly codexRoot: string
  private readonly onChange: () => void
  private readonly debounceMs: number

  private watcher: FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: SessionWatcherOptions) {
    this.claudeRoot = opts.projectsRoot ?? defaultProjectsRoot()
    this.codexRoot = opts.codexRoot ?? defaultCodexRoot()
    this.onChange = opts.onChange
    this.debounceMs = opts.debounceMs ?? 400
  }

  /** Begin watching. No-op if already started. */
  start(): void {
    if (this.watcher) return

    // Watch both agents' roots in one watcher (chokidar accepts an array of globs).
    const globs = [
      path.join(this.claudeRoot, '**', '*.jsonl'),
      path.join(this.codexRoot, '**', '*.jsonl')
    ]
    const watcher = watch(globs, {
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
