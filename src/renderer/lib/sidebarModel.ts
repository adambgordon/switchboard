import type { ConversationGroup, ConversationMeta, LiveState, PtyState } from '../../shared/types'
import { compareRanked, rankOf, type RankOverrides } from './rowRank'
import type { SidebarMode } from './sidebarPrefs'

/**
 * The rail's structure, derived in one pure pass: which rows exist, which folder each belongs to, in
 * what order, and which of them render. It is the single source of truth for visibility — the rail
 * draws it and keyboard navigation walks it — so the two cannot disagree about what is on screen.
 *
 * Nothing here writes. Orders come from rank overrides the caller persists (see `rowRank`); this only
 * reads them, which is what makes it safe to run against a catalog that is still loading.
 */

export interface SidebarRow {
  sessionId: string
  pty: PtyState | null
  meta: ConversationMeta
  pinned: boolean
  liveState: LiveState | null
  /** Pinned rows rank by pin order (`-index`), unpinned rows by `override ?? seed`. */
  rank: number
}

export interface SidebarBlock {
  /** Drag scope and DOM key: `pin:<root>` / `un:<root>` in Folders mode, `pin:*` / `un:*` in All. */
  id: string
  kind: 'pinned' | 'unpinned'
  rows: SidebarRow[]
}

export interface SidebarGroup {
  /** The project root in Folders mode; '' in All mode. */
  key: string
  label: string
  header: boolean
  collapsed: boolean
  /** Empty when collapsed — pins included. */
  blocks: SidebarBlock[]
  /** Unpinned rows withheld by the cap; drives whether Show more / Show less is offered. */
  hidden: number
  /** Any row `asking` or `awaiting`, counted over every row including withheld and collapsed ones. */
  wantsAttention: boolean
}

export interface SidebarModel {
  groups: SidebarGroup[]
  /** Every session that needs the user, in fully-expanded display order: the head tag's count and its
   *  cycle order. Unaffected by search, collapse and caps, so nothing can hide one from it. */
  needsYou: string[]
}

export interface SidebarLimits {
  /** Unpinned rows shown per folder before Show more. */
  folderCap: number
  /** Unpinned rows shown in All mode before Show more. */
  allCap: number
  /** Folders past this index start collapsed unless something says otherwise. */
  autoExpand: number
}

export const DEFAULT_SIDEBAR_LIMITS: SidebarLimits = { folderCap: 5, allCap: 25, autoExpand: 8 }

export interface SidebarInput {
  mode: SidebarMode
  groups: readonly ConversationGroup[]
  /** Live terminals. One without an indexed conversation still gets a row, placed by `projectRoot`. */
  ptys: readonly PtyState[]
  /** Pin order, top first. */
  pinned: readonly string[]
  hidden: ReadonlySet<string>
  rowRanks: RankOverrides
  folderRanks: RankOverrides
  liveState: (pty: PtyState | null, meta: ConversationMeta, id: string) => LiveState | null
  /** Conversations on screen. Never withheld by a cap, and their folders are always expanded. */
  active: ReadonlySet<string>
  /** Stored per-folder collapse preferences. */
  collapsed: Readonly<Record<string, boolean>>
  /** Folders expanded by navigation this session, which keep a folder open after focus moves on. */
  navExpanded: ReadonlySet<string>
  /** Extra unpinned rows revealed per group key. */
  revealed: Readonly<Record<string, number>>
  /** Matching ids while searching, else null. Searching expands everything and lifts every cap. */
  search: ReadonlySet<string> | null
  limits: SidebarLimits
}

/** Display-only meta for a live terminal the index hasn't caught yet (no preview until its transcript is written). */
export function synthMeta(p: PtyState): ConversationMeta {
  return {
    sessionId: p.sessionId,
    agent: p.agent,
    cwd: p.cwd,
    title: p.title,
    preview: '',
    gitBranch: null,
    mtime: p.lastActivity,
    messageCount: 0,
    version: null,
    sizeBytes: 0,
    model: null,
    outputTokens: 0,
    inputTokens: 0,
    inputBaseTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 0,
    firstActivityAt: null,
    provisional: true
  }
}

/**
 * Where a conversation sits when nobody has moved it: when it started. Every fallback must be just as
 * fixed, because a seed that moves silently moves every untouched row. `mtime` is the last resort
 * only — it advances on every write, so a row seeded by it drifts toward the top as it is used.
 */
export function conversationSeed(meta: ConversationMeta): number {
  if (meta.firstActivityAt !== null) return meta.firstActivityAt
  if (meta.birthtimeMs !== undefined && meta.birthtimeMs > 0) return meta.birthtimeMs
  return meta.mtime
}

interface Placed {
  row: SidebarRow
  root: string
  /** The row's conversation seed, whatever its rank — a folder is seeded by its rows' starts. */
  seed: number
}

function needsYou(state: LiveState | null): boolean {
  return state === 'asking' || state === 'awaiting'
}

/** Every visible row once, placed in its project with its rank. */
function placeRows(input: SidebarInput): Placed[] {
  const pinIndex = new Map<string, number>()
  input.pinned.forEach((id, i) => {
    if (!pinIndex.has(id)) pinIndex.set(id, i)
  })
  const ptyBySession = new Map<string, PtyState>()
  for (const p of input.ptys) ptyBySession.set(p.sessionId, p)

  const out: Placed[] = []
  const seen = new Set<string>()
  const place = (id: string, meta: ConversationMeta, pty: PtyState | null, root: string, seed: number): void => {
    if (seen.has(id) || input.hidden.has(id)) return
    seen.add(id)
    const pin = pinIndex.get(id)
    out.push({
      row: {
        sessionId: id,
        pty,
        meta,
        pinned: pin !== undefined,
        liveState: input.liveState(pty, meta, id),
        rank: pin !== undefined ? -pin : rankOf(id, seed, input.rowRanks)
      },
      root,
      seed
    })
  }

  for (const g of input.groups) {
    for (const meta of g.conversations) {
      place(meta.sessionId, meta, ptyBySession.get(meta.sessionId) ?? null, g.root, conversationSeed(meta))
    }
  }
  // A terminal with no indexed conversation yet — a new session before its first message, or one
  // that never proves its identity. It starts where its terminal started.
  for (const p of input.ptys) place(p.sessionId, synthMeta(p), p, p.projectRoot, p.startedAt)
  return out
}

/** Basename, with a bare repository's `.git` suffix dropped. */
function baseLabel(root: string): string {
  const parts = root.split('/').filter((s) => s.length > 0)
  if (parts.length === 0) return root
  const last = parts[parts.length - 1]
  return last.length > 4 && last.endsWith('.git') ? last.slice(0, -4) : last
}

/**
 * Labels for a set of roots: the basename, widened by parent segments only where two roots would
 * otherwise read the same, until each is unique.
 */
export function folderLabels(roots: readonly string[]): Map<string, string> {
  const segments = new Map(roots.map((r) => [r, r.split('/').filter((s) => s.length > 0)]))
  const labelAt = (root: string, depth: number): string => {
    const segs = segments.get(root)!
    if (segs.length === 0) return root
    if (depth === 1) return baseLabel(root)
    return segs.slice(Math.max(0, segs.length - depth), -1).join('/') + '/' + baseLabel(root)
  }
  const out = new Map<string, string>()
  let pending = [...new Set(roots)]
  for (let depth = 1; pending.length > 0; depth++) {
    const byLabel = new Map<string, string[]>()
    for (const r of pending) {
      const l = labelAt(r, depth)
      byLabel.set(l, [...(byLabel.get(l) ?? []), r])
    }
    const next: string[] = []
    for (const [label, rs] of byLabel) {
      // A root with no segments left to add keeps its full path, which is unique by construction.
      const exhausted = rs.filter((r) => depth >= segments.get(r)!.length)
      if (rs.length === 1) out.set(rs[0], label)
      else {
        for (const r of exhausted) out.set(r, r)
        next.push(...rs.filter((r) => !exhausted.includes(r)))
      }
    }
    pending = next
  }
  return out
}

function isCollapsed(input: SidebarInput, key: string, index: number, rows: readonly SidebarRow[]): boolean {
  if (input.search) return false
  // Derived, not stored: whatever path made a conversation active, its folder cannot be closed on it.
  if (rows.some((r) => input.active.has(r.sessionId))) return false
  if (input.navExpanded.has(key)) return false
  if (Object.hasOwn(input.collapsed, key)) return input.collapsed[key]
  return index >= input.limits.autoExpand
}

function sortRows(rows: SidebarRow[]): SidebarRow[] {
  return rows.sort((a, b) => compareRanked({ id: a.sessionId, rank: a.rank }, { id: b.sessionId, rank: b.rank }))
}

function buildGroup(
  input: SidebarInput,
  key: string,
  label: string,
  index: number,
  all: SidebarRow[]
): SidebarGroup | null {
  const wantsAttention = all.some((r) => needsYou(r.liveState))
  const rows = input.search ? all.filter((r) => input.search!.has(r.sessionId)) : all
  if (rows.length === 0) return null
  const header = input.mode === 'folders'
  const collapsed = header && isCollapsed(input, key, index, rows)
  const pinned = sortRows(rows.filter((r) => r.pinned))
  const unpinned = sortRows(rows.filter((r) => !r.pinned))

  const cap = input.mode === 'all' ? input.limits.allCap : input.limits.folderCap
  let shown = unpinned
  if (!input.search) {
    // Capped by POSITION, so whether an idle row shows never depends on another row's liveness. Rows
    // past the cap that are live or on screen still render, after the rest, in their own order.
    const limit = cap + (input.revealed[key] ?? 0)
    shown = [
      ...unpinned.slice(0, limit),
      ...unpinned.slice(limit).filter((r) => r.pty !== null || input.active.has(r.sessionId))
    ]
  }
  const id = header ? key : '*'
  const blocks: SidebarBlock[] = []
  if (!collapsed) {
    if (pinned.length > 0) blocks.push({ id: `pin:${id}`, kind: 'pinned', rows: pinned })
    if (shown.length > 0) blocks.push({ id: `un:${id}`, kind: 'unpinned', rows: shown })
  }
  return {
    key,
    label,
    header,
    collapsed,
    blocks,
    hidden: collapsed ? 0 : unpinned.length - shown.length,
    wantsAttention
  }
}

export function buildSidebar(input: SidebarInput): SidebarModel {
  const placed = placeRows(input)

  let buckets: { key: string; rows: SidebarRow[] }[]
  if (input.mode === 'all') {
    buckets = [{ key: '', rows: placed.map((p) => p.row) }]
  } else {
    const byRoot = new Map<string, { rows: SidebarRow[]; seed: number }>()
    for (const p of placed) {
      const b = byRoot.get(p.root)
      if (b) {
        b.rows.push(p.row)
        b.seed = Math.min(b.seed, p.seed)
      } else byRoot.set(p.root, { rows: [p.row], seed: p.seed })
    }
    // A folder is seeded by its EARLIEST conversation, which is fixed once seen. Its latest would lift
    // the folder every time a conversation started in it — motion caused by activity.
    buckets = [...byRoot]
      .map(([root, b]) => ({ id: root, rank: rankOf(root, b.seed, input.folderRanks), rows: b.rows }))
      .sort(compareRanked)
      .map((b) => ({ key: b.id, rows: b.rows }))
  }

  const labels = input.mode === 'folders' ? folderLabels(buckets.map((b) => b.key)) : new Map<string, string>()
  const groups: SidebarGroup[] = []
  buckets.forEach((b, i) => {
    const g = buildGroup(input, b.key, labels.get(b.key) ?? '', i, b.rows)
    if (g) groups.push(g)
  })

  const order: string[] = []
  for (const b of buckets) {
    const rows = sortRows(b.rows.filter((r) => r.pinned)).concat(sortRows(b.rows.filter((r) => !r.pinned)))
    for (const r of rows) if (needsYou(r.liveState)) order.push(r.sessionId)
  }
  return { groups, needsYou: order }
}

/** The rows on screen, top to bottom — what keyboard navigation steps through. */
export function visibleRows(model: SidebarModel): SidebarRow[] {
  return model.groups.flatMap((g) => g.blocks.flatMap((b) => b.rows))
}
