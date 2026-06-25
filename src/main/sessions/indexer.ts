/**
 * Build the sidebar's grouped conversation index by scanning every session file from BOTH agents —
 * Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) — and grouping the parsed
 * metadata by the absolute cwd each session ran in. Grouping by cwd unifies the agents: a repo's
 * Claude and Codex conversations land in the same group.
 *
 * Pure Node — no Electron, no DOM. Resilient: a single unreadable file or
 * directory must never crash the whole index.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ConversationGroup, ConversationMeta } from '../../shared/types'
import { extractMeta } from './parser'
import { defaultCodexRoot, extractCodexMeta, listCodexRollouts } from './codexParser'

/** Default projects root: `~/.claude/projects`. */
function defaultProjectsRoot(): string {
  return path.join(homedir(), '.claude', 'projects')
}

/** Cap on concurrent file reads, to avoid EMFILE on large projects dirs. */
const CONCURRENCY = 16

/**
 * Run `worker` over `items` with at most `limit` in flight at once. A tiny
 * promise-pool so we don't pull in a dependency. Results preserve input order;
 * a rejected worker surfaces as a rejection of the returned promise (callers
 * here pass workers that never reject).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  async function runner(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }

  const poolSize = Math.max(1, Math.min(limit, items.length))
  const runners: Promise<void>[] = []
  for (let i = 0; i < poolSize; i++) runners.push(runner())
  await Promise.all(runners)
  return results
}

/** List immediate subdirectories of `root`. Returns [] if `root` is missing/unreadable. */
async function listProjectDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(path.join(root, entry.name))
    }
    return dirs
  } catch {
    return []
  }
}

/** List `*.jsonl` files directly inside `dir`. Returns [] if `dir` is unreadable. */
async function listSessionFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(dir, entry.name))
      }
    }
    return files
  } catch {
    return []
  }
}

/** extractMeta that swallows any unexpected error into null (extra safety). */
async function safeExtractMeta(filePath: string): Promise<ConversationMeta | null> {
  try {
    return await extractMeta(filePath)
  } catch {
    return null
  }
}

/** extractCodexMeta that swallows any unexpected error into null (extra safety). */
async function safeExtractCodexMeta(filePath: string): Promise<ConversationMeta | null> {
  try {
    return await extractCodexMeta(filePath)
  } catch {
    return null
  }
}

/**
 * Per-file parsed-meta cache, keyed by absolute path. The caller owns it so it persists across
 * re-index passes; pass nothing to {@link indexConversations} for a one-shot index (a fresh throwaway
 * cache, i.e. no reuse).
 */
export type MetaCache = Map<string, ConversationMeta>

/**
 * Stat-gate a per-file extract: reuse the cached meta when the file's (mtime, size) is unchanged,
 * else re-read + re-parse and refresh the cache. Transcript JSONL is append-only, so any content
 * change moves both mtime and size — making (mtime, size) a sound, cheap invalidation key. This keeps
 * the live-turn poll (which re-indexes every ~500ms) from re-reading + re-parsing every transcript on
 * disk each pass; only the file(s) actually being appended get reprocessed.
 */
async function extractWithCache(
  filePath: string,
  cache: MetaCache,
  extract: (fp: string) => Promise<ConversationMeta | null>
): Promise<ConversationMeta | null> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(filePath)
  } catch {
    cache.delete(filePath)
    return null
  }
  const cached = cache.get(filePath)
  if (cached && cached.mtime === st.mtimeMs && cached.sizeBytes === st.size) return cached
  const meta = await extract(filePath)
  if (meta) cache.set(filePath, meta)
  else cache.delete(filePath)
  return meta
}

/**
 * Derive the display label for a group keyed on `cwd`: the basename, falling
 * back to the full cwd when the basename is empty or ambiguous (e.g. `/`).
 */
function labelForCwd(cwd: string): string {
  const base = path.basename(cwd)
  return base.length > 0 ? base : cwd
}

/**
 * Gather Claude Code conversation metadata from the projects root. Drops zero-message sessions and
 * `/bg` daemon sessions (Claude Code itself hides those from `/resume`; surfacing them produces a
 * phantom duplicate of the interactive conversation they forked from). [] if the root is missing.
 */
async function indexClaudeMetas(root: string, cache: MetaCache): Promise<ConversationMeta[]> {
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) return []
  } catch {
    return []
  }

  const projectDirs = await listProjectDirs(root)
  const fileLists = await Promise.all(projectDirs.map((dir) => listSessionFiles(dir)))
  const allFiles = fileLists.flat()
  const metas = await mapWithConcurrency(allFiles, CONCURRENCY, (f) =>
    extractWithCache(f, cache, safeExtractMeta)
  )

  const out: ConversationMeta[] = []
  for (const meta of metas) {
    if (!meta) continue
    if (meta.messageCount === 0) continue
    if (meta.sessionKind === 'bg') continue
    out.push(meta)
  }
  return out
}

/**
 * Gather Codex conversation metadata from the sessions root. `extractCodexMeta` already returns null
 * for non-interactive (`codex exec`) rollouts; here we additionally drop zero-message ones. [] if
 * the root is missing.
 */
async function indexCodexMetas(root: string, cache: MetaCache): Promise<ConversationMeta[]> {
  const files = await listCodexRollouts(root)
  const metas = await mapWithConcurrency(files, CONCURRENCY, (f) =>
    extractWithCache(f, cache, safeExtractCodexMeta)
  )

  const out: ConversationMeta[] = []
  for (const meta of metas) {
    if (!meta) continue
    if (meta.messageCount === 0) continue
    out.push(meta)
  }
  return out
}

/**
 * Scan both agents' roots and return conversations grouped by exact cwd. Groups are sorted by
 * `latestMtime` desc; conversations within each group are sorted by `mtime` desc. Conversations with
 * no parseable content, no cwd, or zero messages are dropped.
 */
export async function indexConversations(
  projectsRoot?: string,
  codexRoot?: string,
  cache?: MetaCache
): Promise<ConversationGroup[]> {
  const claudeRoot = projectsRoot ?? defaultProjectsRoot()
  const codexSessionsRoot = codexRoot ?? defaultCodexRoot()
  const fileCache = cache ?? new Map()

  const [claudeMetas, codexMetas] = await Promise.all([
    indexClaudeMetas(claudeRoot, fileCache),
    indexCodexMetas(codexSessionsRoot, fileCache)
  ])

  const groups = new Map<string, ConversationMeta[]>()
  for (const meta of [...claudeMetas, ...codexMetas]) {
    const existing = groups.get(meta.cwd)
    if (existing) existing.push(meta)
    else groups.set(meta.cwd, [meta])
  }

  const result: ConversationGroup[] = []
  for (const [cwd, conversations] of groups) {
    conversations.sort((a, b) => b.mtime - a.mtime)
    const latestMtime = conversations.reduce((max, c) => (c.mtime > max ? c.mtime : max), 0)
    result.push({ cwd, label: labelForCwd(cwd), conversations, latestMtime })
  }

  result.sort((a, b) => b.latestMtime - a.latestMtime)
  return result
}
