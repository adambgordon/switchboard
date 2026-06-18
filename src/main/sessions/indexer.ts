/**
 * Build the sidebar's grouped conversation index by scanning every session file
 * under the Claude Code projects root and grouping the parsed metadata by the
 * absolute cwd each session ran in.
 *
 * Pure Node — no Electron, no DOM. Resilient: a single unreadable file or
 * directory must never crash the whole index.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ConversationGroup, ConversationMeta } from '../../shared/types'
import { extractMeta } from './parser'

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

/**
 * Derive the display label for a group keyed on `cwd`: the basename, falling
 * back to the full cwd when the basename is empty or ambiguous (e.g. `/`).
 */
function labelForCwd(cwd: string): string {
  const base = path.basename(cwd)
  return base.length > 0 ? base : cwd
}

/**
 * Scan the projects root and return conversations grouped by exact cwd.
 * Groups are sorted by `latestMtime` desc; conversations within each group are
 * sorted by `mtime` desc. Conversations with no parseable content, no cwd, or
 * zero messages are dropped.
 */
export async function indexConversations(projectsRoot?: string): Promise<ConversationGroup[]> {
  const root = projectsRoot ?? defaultProjectsRoot()

  // Confirm the root exists and is a directory; otherwise yield an empty index.
  try {
    const rootStat = await stat(root)
    if (!rootStat.isDirectory()) return []
  } catch {
    return []
  }

  const projectDirs = await listProjectDirs(root)
  const fileLists = await Promise.all(projectDirs.map((dir) => listSessionFiles(dir)))
  const allFiles = fileLists.flat()

  const metas = await mapWithConcurrency(allFiles, CONCURRENCY, safeExtractMeta)

  const groups = new Map<string, ConversationMeta[]>()
  for (const meta of metas) {
    if (!meta) continue
    if (meta.messageCount === 0) continue
    // Drop background-job (daemon) sessions — `/bg` / `claude --bg`. Claude Code itself hides these
    // from `/resume`; surfacing them here produces a phantom duplicate of the interactive
    // conversation they forked from, with a stale (frozen) transcript. See parser.ts `sessionKind`.
    if (meta.sessionKind === 'bg') continue
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
