/**
 * Build the sidebar's grouped conversation index by scanning every session file from BOTH agents —
 * Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) — and grouping the parsed
 * metadata by the absolute cwd each session ran in. Grouping by cwd unifies the agents: a repo's
 * Claude and Codex conversations land in the same group. Each group also carries the project its cwd
 * belongs to (`root` / `worktree`, see projectRoot.ts) so the rail can fold a repository's
 * subdirectories and worktrees together, and whether the cwd still exists (`exists`).
 *
 * Pure Node — no Electron, no DOM. Resilient: a single unreadable file or
 * directory must never crash the whole index.
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ConversationGroup, ConversationIndexSnapshot, ConversationMeta } from '../../shared/types'
import { extractMeta } from './parser'
import { defaultCodexRoot, extractCodexMeta, listCodexRollouts } from './codexParser'
import { readCodexThreads } from './codexThreadsDb'
import { readCodexSessionNames, resolveCodexTitle } from './codexSessionIndex'
import { ProjectRoots, type ProjectRoot } from './projectRoot'

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
 * Gather Claude Code conversation metadata from the projects root. Background (`bg`) transcripts are
 * independently resumable conversations and remain visible, matching Claude Code's `/resume` picker;
 * internal `daemon` / `daemon-worker` sessions do not. Drops zero-message sessions and headless
 * (`claude -p` / Agent SDK) transcripts — the counterpart of dropping `codex exec` rollouts. Headless
 * ones are left out of this pass only, never added to the sticky hidden set, because an interactive
 * resume turns one into a real conversation that must reappear. [] if the root is missing.
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
    if (meta.sessionKind === 'daemon' || meta.sessionKind === 'daemon-worker') continue
    if (meta.headless) continue
    out.push(meta)
  }
  return out
}

/**
 * Gather Codex conversation metadata from the sessions root. `extractCodexMeta` already returns null
 * for non-interactive (`codex exec`) rollouts; here we additionally drop zero-message and subagent
 * threads and report their ids separately. Empty results if the root is missing.
 */
async function indexCodexMetas(root: string, cache: MetaCache): Promise<{
  metas: ConversationMeta[]
  hiddenSessionIds: string[]
}> {
  const files = await listCodexRollouts(root)
  const metas = await mapWithConcurrency(files, CONCURRENCY, (f) =>
    extractWithCache(f, cache, safeExtractCodexMeta)
  )

  // Consult Codex's own stores once per pass (both reads are cheap — a tiny SQLite table and a small
  // append-only file): DROP archived threads (Codex hides those from its own list, so surfacing them
  // would make the two browsers disagree), and resolve each title the way Codex itself does. A rename
  // writes both the volatile `threads.title` (re-derived to the first message on resume) and the
  // durable `session_index.jsonl`; resolveCodexTitle prefers a distinct DB title, else the session
  // name, else the rollout-derived one — so a reverted DB title still surfaces the real rename. Spread
  // so the overlay doesn't mutate the cached meta (the cache keys on file mtime/size, not title).
  const threads = readCodexThreads(path.dirname(root))
  const sessionNames = readCodexSessionNames(path.dirname(root))

  const out: ConversationMeta[] = []
  const hiddenSessionIds: string[] = []
  for (const meta of metas) {
    if (!meta) continue
    if (meta.codexSubagent) {
      hiddenSessionIds.push(meta.sessionId)
      continue
    }
    if (meta.messageCount === 0) continue
    const row = threads.get(meta.sessionId)
    if (row?.archived) continue
    const title = resolveCodexTitle({
      rolloutTitle: meta.title,
      dbTitle: row?.title ?? null,
      dbFirstUserMessage: row?.firstUserMessage ?? null,
      sessionName: sessionNames.get(meta.sessionId) ?? null
    })
    out.push(title === meta.title ? meta : { ...meta, title })
  }
  return { metas: out, hiddenSessionIds }
}

/** Resolve a batch of cwds to their projects in one call (see {@link ProjectRoots.resolveAll}). */
export type ProjectRootsResolver = (
  cwds: readonly string[],
  missing: ReadonlySet<string>
) => ReadonlyMap<string, ProjectRoot>

export interface IndexOptions {
  /**
   * Project-root resolver. The caller owns it so its memo and persisted cache span re-index passes;
   * omit for a one-shot index (a fresh, unpersisted resolver, i.e. no reuse).
   */
  resolveRoots?: ProjectRootsResolver
  /** Which cwds exist. Defaults to one process-wide {@link existenceProbe} over the real filesystem. */
  existing?: ExistenceProbe
}

/**
 * Which of `cwds` exist as directories. `exists` is the best answer available — this pass's, else
 * the last one — and is what the rail and chooser show. `verified` holds only cwds whose check
 * answered yes THIS pass, and is the only licence to walk a cwd synchronously: a last-known answer
 * says nothing about whether the volume responds now.
 */
export interface Existence {
  exists: Set<string>
  verified: Set<string>
}

export type ExistenceProbe = (cwds: readonly string[]) => Promise<Existence>

/** How long a pass waits for existence checks before publishing without them. */
export const EXISTENCE_DEADLINE_MS = 200

/**
 * Existence checks allowed unsettled at once. Node runs asynchronous filesystem calls on a small
 * shared thread pool (four threads by default), and a check against an unresponsive volume holds its
 * thread until the volume answers — cancelling the wait does not cancel the call. Capping the checks
 * leaves the rest of the pool for the transcript reads the app actually needs.
 */
export const EXISTENCE_MAX_INFLIGHT = 2

/**
 * Whether each distinct cwd exists right now — checked every pass, deliberately not memoized like the
 * project root: a directory deleted mid-launch must drop out of the new-conversation chooser on the
 * next pass, not the next launch.
 *
 * Bounded three ways, because existence is optional metadata and a historical cwd on an unresponsive
 * volume can leave its check pending indefinitely:
 * - a pass waits at most `deadlineMs`, so no check can withhold the index;
 * - at most `maxInflight` checks are unsettled at once, so hung ones cannot starve the thread pool;
 * - a cwd whose check is still pending is not checked or subscribed to again, so a hung check costs
 *   one call and one handler however many passes it outlives.
 * A cwd with no answer this pass reads as its last known answer, or missing if it never had one —
 * but only for display: it is never `verified`, so the resolver does not walk it on that answer.
 */
export function existenceProbe(
  isDirectory: (cwd: string) => Promise<boolean>,
  deadlineMs = EXISTENCE_DEADLINE_MS,
  maxInflight = EXISTENCE_MAX_INFLIGHT
): ExistenceProbe {
  const pending = new Set<string>()
  const lastKnown = new Map<string, boolean>()
  let inflight = 0
  return (cwds) =>
    new Promise<Existence>((resolve) => {
      const queue = [...new Set(cwds)].filter((cwd) => !pending.has(cwd))
      const verified = new Set<string>()
      let running = 0
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve({ exists: new Set(cwds.filter((cwd) => lastKnown.get(cwd) === true)), verified: new Set(verified) })
      }
      const pump = (): void => {
        while (!done && inflight < maxInflight && queue.length > 0) {
          const cwd = queue.shift()!
          inflight++
          running++
          pending.add(cwd)
          isDirectory(cwd)
            .catch(() => false)
            .then((exists) => {
              lastKnown.set(cwd, exists)
              if (exists) verified.add(cwd)
              inflight--
              running--
              pending.delete(cwd)
              pump()
            })
        }
        // Nothing of ours outstanding: either every check answered, or the remaining slots are held by
        // checks from earlier passes, which this pass must not wait on.
        if (running === 0) finish()
      }
      const timer = setTimeout(finish, deadlineMs)
      pump()
    })
}

const defaultExistence = existenceProbe(async (cwd) => (await stat(cwd)).isDirectory())

/**
 * Scan both agents' roots and return conversations grouped by exact cwd. Groups are sorted by
 * `latestMtime` desc; conversations within each group are sorted by `mtime` desc. Conversations with
 * no parseable content, no cwd, or zero messages are dropped.
 */
export async function indexConversations(
  projectsRoot?: string,
  codexRoot?: string,
  cache?: MetaCache,
  options: IndexOptions = {}
): Promise<ConversationIndexSnapshot> {
  const claudeRoot = projectsRoot ?? defaultProjectsRoot()
  const codexSessionsRoot = codexRoot ?? defaultCodexRoot()
  const fileCache = cache ?? new Map()
  const resolveRoots = options.resolveRoots ?? ((cwds, missing) => new ProjectRoots().resolveAll(cwds, missing))

  const [claudeMetas, codex] = await Promise.all([
    indexClaudeMetas(claudeRoot, fileCache),
    indexCodexMetas(codexSessionsRoot, fileCache)
  ])

  const groups = new Map<string, ConversationMeta[]>()
  for (const meta of [...claudeMetas, ...codex.metas]) {
    const existing = groups.get(meta.cwd)
    if (existing) existing.push(meta)
    else groups.set(meta.cwd, [meta])
  }

  const cwds = [...groups.keys()]
  const { exists, verified } = await (options.existing ?? defaultExistence)(cwds)
  const roots = resolveRoots(cwds, new Set(cwds.filter((c) => !verified.has(c))))

  const result: ConversationGroup[] = []
  for (const [cwd, conversations] of groups) {
    conversations.sort((a, b) => b.mtime - a.mtime)
    const latestMtime = conversations.reduce((max, c) => (c.mtime > max ? c.mtime : max), 0)
    const { root, worktree } = roots.get(cwd) ?? { root: cwd, worktree: false }
    result.push({
      cwd,
      root,
      worktree,
      exists: exists.has(cwd),
      label: labelForCwd(cwd),
      conversations,
      latestMtime
    })
  }

  result.sort((a, b) => b.latestMtime - a.latestMtime)
  return { groups: result, hiddenSessionIds: codex.hiddenSessionIds.sort() }
}
