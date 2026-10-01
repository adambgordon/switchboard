/**
 * The sidebar-metadata cache, kept across launches so a launch can show the conversation list from
 * disk instead of re-parsing every transcript first.
 *
 * Every entry is a parse result for one session file, valid while that file's (mtime, size) is
 * unchanged — transcripts are append-only, so any content change moves both. Entries are also tied to
 * the code that produced them: the cache file is named for a fingerprint of the parsers, so a build
 * whose parsers changed never treats an older build's results as current.
 *
 * Three kinds of entry:
 * - fresh — produced by THIS build's parsers; served while the file is unchanged.
 * - stale — produced by another build, or for a file that changed while the app was closed. Served
 *   only to answer a launch quickly, never relied on past it: each is queued for a background re-parse.
 * - pending — files queued for that re-parse, with the (mtime, size) they had when queued.
 *
 * How a file is answered:
 * 1. A fresh entry that matches the file → that entry.
 * 2. During the launch pass, or for a pending file that has not changed since it was queued → the
 *    stale (or outdated fresh) entry, or nothing, and the file stays queued. "Nothing" hides a file
 *    nobody has parsed yet, so a session that should be hidden can never be shown on a guess.
 * 3. Anything else — typically a file a live session is writing → parsed now, ahead of the queue.
 *
 * On a very first launch there is nothing to serve, so (2) does not apply: every file is parsed
 * before the first answer, and the first conversation list is complete, as it has always been.
 *
 * Pure Node — no Electron. Persistence is best-effort: a lost or corrupt file only costs a slow
 * launch, never a wrong answer.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { AgentKind, ConversationMeta } from '../../shared/types'
import type { JobPriority } from './jobQueue'

const DIR = 'session-meta-cache'
const VERSION = 1
/** Debounce for writing the cache after it changes. A quit flushes immediately. */
const SAVE_DELAY_MS = 2000

/** Parse one session file's metadata at the given priority; resolves null when it has none. */
export type PrioritizedExtract = (
  agent: AgentKind,
  filePath: string,
  priority: JobPriority
) => Promise<ConversationMeta | null>

export interface MetaStoreOptions {
  /** Directory holding the cache files (the app's userData). Omit for no persistence. */
  dir?: string
  /** Fingerprint of the parsers in this build. Null when unknown: nothing on disk is trusted as fresh. */
  fingerprint: string | null
  extract: PrioritizedExtract
}

interface Pending {
  agent: AgentKind
  mtimeMs: number
  size: number
}

interface CacheFile {
  version: number
  entries: Record<string, ConversationMeta>
  stale: Record<string, ConversationMeta>
}

function isMeta(v: unknown): v is ConversationMeta {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    typeof m.sessionId === 'string' &&
    (m.agent === 'claude' || m.agent === 'codex') &&
    typeof m.cwd === 'string' &&
    typeof m.title === 'string' &&
    typeof m.mtime === 'number' &&
    typeof m.sizeBytes === 'number' &&
    typeof m.messageCount === 'number'
  )
}

/** Entries of one section of a cache file; malformed entries are dropped, never fatal. */
function section(value: unknown): Map<string, ConversationMeta> {
  const out = new Map<string, ConversationMeta>()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [file, meta] of Object.entries(value)) if (isMeta(meta)) out.set(file, meta)
  return out
}

function readCacheFile(file: string): { entries: Map<string, ConversationMeta>; stale: Map<string, ConversationMeta> } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Partial<CacheFile>
  if (obj.version !== VERSION) return null
  return { entries: section(obj.entries), stale: section(obj.stale) }
}

/** A fingerprint is used as a file name, so only a plain token is accepted. */
function safeName(fingerprint: string | null): string | null {
  return fingerprint && /^[A-Za-z0-9_-]{1,128}$/.test(fingerprint) ? fingerprint : null
}

function matches(meta: ConversationMeta, st: { mtimeMs: number; size: number }): boolean {
  return meta.mtime === st.mtimeMs && meta.sizeBytes === st.size
}

export class MetaStore {
  private readonly fresh = new Map<string, ConversationMeta>()
  private readonly stale = new Map<string, ConversationMeta>()
  private readonly pending = new Map<string, Pending>()
  /** Files this process parsed to "no metadata": a save never restores another copy's entry for them. */
  private readonly dropped = new Set<string>()
  private readonly dir: string | null
  private readonly name: string | null
  private readonly extract: PrioritizedExtract
  /** True until the first pass ends: the window in which stale answers are allowed for any file. */
  private launching = true
  /** Whether anything was loaded from disk — without it, a launch has nothing to answer from. */
  private readonly warm: boolean
  /** Files seen in the pass in progress, and in the last complete one (what a save keeps). */
  private seenNow: Set<string> | null = null
  private seenLast: Set<string> | null = null
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: MetaStoreOptions) {
    this.dir = opts.dir ? path.join(opts.dir, DIR) : null
    this.name = safeName(opts.fingerprint)
    this.extract = opts.extract
    this.warm = this.load()
  }

  /** Mark the start of an index pass; every file the pass resolves is recorded as still present. */
  beginPass(): void {
    this.seenNow = new Set()
  }

  /**
   * Mark the end of an index pass. Entries for files the pass did not list are forgotten (deleted
   * transcripts), and the launch window — where any file may be answered from a stale entry — closes.
   */
  endPass(): void {
    const seen = this.seenNow
    this.seenNow = null
    this.launching = false
    if (!seen) return
    this.seenLast = seen
    for (const map of [this.fresh, this.stale, this.pending]) {
      for (const file of map.keys()) {
        if (!seen.has(file)) {
          map.delete(file)
          this.dirty = true
        }
      }
    }
    if (this.dirty) this.schedule()
  }

  /** One file's metadata for the pass in progress. See the module doc for the three cases. */
  async resolve(agent: AgentKind, filePath: string): Promise<ConversationMeta | null> {
    this.seenNow?.add(filePath)
    let st: { mtimeMs: number; size: number }
    try {
      st = await stat(filePath)
    } catch {
      this.forget(filePath)
      return null
    }
    const fresh = this.fresh.get(filePath)
    if (fresh && matches(fresh, st)) return fresh

    const queued = this.pending.get(filePath)
    const unchangedSinceQueued = queued !== undefined && queued.mtimeMs === st.mtimeMs && queued.size === st.size
    if ((this.launching && this.warm) || unchangedSinceQueued) {
      if (!queued) this.pending.set(filePath, { agent, mtimeMs: st.mtimeMs, size: st.size })
      return fresh ?? this.stale.get(filePath) ?? null
    }

    this.pending.delete(filePath)
    const meta = await this.extract(agent, filePath, 'foreground').catch(() => null)
    this.accept(filePath, meta)
    return meta
  }

  /** Files still owed a background re-parse. */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * Re-parse every queued file in the background. `onProgress` is called after each one with how
   * many are left. A file parsed meanwhile in the foreground (because it changed) keeps that result.
   */
  revalidate(onProgress: (remaining: number) => void): void {
    for (const [filePath, queued] of [...this.pending]) {
      void this.extract(queued.agent, filePath, 'background').catch(() => null).then((meta) => {
        if (this.pending.get(filePath) !== queued) return
        this.pending.delete(filePath)
        this.accept(filePath, meta)
        onProgress(this.pending.size)
      })
    }
  }

  /** Write the cache now if it has unsaved changes. Synchronous — safe to call while quitting. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.dirty) this.save()
  }

  private accept(filePath: string, meta: ConversationMeta | null): void {
    if (meta) {
      this.fresh.set(filePath, meta)
    } else {
      this.fresh.delete(filePath)
      this.dropped.add(filePath)
    }
    this.stale.delete(filePath)
    this.dirty = true
    this.schedule()
  }

  private forget(filePath: string): void {
    const had = this.fresh.delete(filePath)
    const hadStale = this.stale.delete(filePath)
    this.pending.delete(filePath)
    if (had || hadStale) {
      this.dirty = true
      this.schedule()
    }
  }

  private schedule(): void {
    if (!this.dir || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save()
    }, SAVE_DELAY_MS)
    this.saveTimer.unref?.()
  }

  /**
   * Load this build's cache file; failing that, the most recent other build's file, all of it stale.
   * Returns whether anything was loaded.
   */
  private load(): boolean {
    if (!this.dir) return false
    const own = this.name ? readCacheFile(path.join(this.dir, `${this.name}.json`)) : null
    if (own) {
      for (const [file, meta] of own.entries) this.fresh.set(file, meta)
      for (const [file, meta] of own.stale) this.stale.set(file, meta)
      return own.entries.size + own.stale.size > 0
    }
    for (const other of this.otherFiles()) {
      const prior = readCacheFile(other)
      if (!prior) continue
      for (const [file, meta] of prior.stale) this.stale.set(file, meta)
      for (const [file, meta] of prior.entries) this.stale.set(file, meta)
      if (this.stale.size > 0) return true
    }
    return false
  }

  /** Other builds' cache files, most recently written first. */
  private otherFiles(): string[] {
    if (!this.dir) return []
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const own = this.name ? `${this.name}.json` : null
    return names
      .filter((n) => n.endsWith('.json') && n !== own)
      .map((n) => {
        const file = path.join(this.dir!, n)
        try {
          return { file, at: statSync(file).mtimeMs }
        } catch {
          return { file, at: 0 }
        }
      })
      .sort((a, b) => b.at - a.at)
      .map((f) => f.file)
  }

  /**
   * Write this build's file through a rename, so a reader never sees half of it. Several app
   * processes can share the directory, so what is on disk now is folded in for files this process
   * has no entry for — limited to files the last full pass listed (a deleted transcript's entry is
   * not resurrected) and never for a file this process itself found to have no metadata (or that
   * entry would come back on every save). Older builds' files are pruned, keeping the most recent
   * one as a seed for a downgrade. Never throws: this runs from a timer and while quitting.
   */
  private save(): void {
    if (!this.dir || !this.name) {
      this.dirty = false
      return
    }
    const file = path.join(this.dir, `${this.name}.json`)
    const onDisk = readCacheFile(file)
    const keep = (f: string) => !this.dropped.has(f) && (this.seenLast === null || this.seenLast.has(f))
    const entries: Record<string, ConversationMeta> = {}
    const staleOut: Record<string, ConversationMeta> = {}
    for (const [f, meta] of onDisk?.entries ?? []) {
      if (keep(f) && !this.fresh.has(f) && !this.stale.has(f)) entries[f] = meta
    }
    for (const [f, meta] of onDisk?.stale ?? []) {
      if (keep(f) && !this.fresh.has(f) && !this.stale.has(f) && !(f in entries)) staleOut[f] = meta
    }
    for (const [f, meta] of this.fresh) entries[f] = meta
    for (const [f, meta] of this.stale) staleOut[f] = meta
    const body: CacheFile = { version: VERSION, entries, stale: staleOut }
    const temp = `${file}.${process.pid}.tmp`
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(temp, JSON.stringify(body))
      renameSync(temp, file)
      this.dirty = false
    } catch {
      removeQuietly(temp)
      return
    }
    for (const old of this.otherFiles().slice(1)) removeQuietly(old)
  }
}

/** Delete a file, ignoring every failure — `force` only covers a missing file, not e.g. EACCES. */
function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    /* a leftover file only costs disk space */
  }
}
