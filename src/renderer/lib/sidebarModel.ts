import type { ConversationGroup, ConversationMeta, LiveState, PtyState } from '../../shared/types'
import {
  absorbBindFolder,
  bumpRank,
  compareRanked,
  holdRank,
  rankOf,
  topRank,
  type RankOverrides,
  type Ranked
} from './rowRank'
import type { SidebarMode } from './sidebarPrefs'
import { admits, hiddenBy, type RailFilter, type UserHidden } from './railFilter'

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
  /** Why the user's hide covers it, or null when it does not (`hiddenBy`). A hidden row is drawn
   *  grayed whatever the filter, so gray means one thing: hidden. */
  hiddenBy: 'folder' | 'self' | null
  /** Outside the window's filter. Such a row renders only while it is on screen. */
  outside: boolean
}

export interface SidebarBlock {
  /** Drag scope and DOM key: `pin:<root>` / `un:<root>` in Folders mode, `pin:*` / `un:*` in All. */
  id: string
  kind: 'pinned' | 'unpinned'
  rows: SidebarRow[]
  /** How many rows, from the top, are shown in rank order. The rest are live or open rows past the
   *  cap, which rank below rows the block withholds. */
  capped: number
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
  withheld: number
  /** Any row `asking` or `awaiting` among those the filter admits, withheld and collapsed ones
   *  included. Never one the filter keeps off the rail: bold would point at something not there. */
  wantsAttention: boolean
  /** The user has hidden this folder, so its header is drawn grayed. Folders mode only. */
  folderHidden: boolean
}

export interface FolderRank {
  /** Effective rank: the stored folder override, else the seed. */
  rank: number
  /** The earliest conversation seed in the folder. */
  seed: number
}

/** Where one row sits, whatever is rendered — what a drag, a Resume or a bind needs to write. */
export interface RowPlace {
  rank: number
  /** The row's conversation seed, or its terminal's start when nothing is indexed yet. */
  seed: number
  root: string
  pinned: boolean
}

export interface SidebarModel {
  groups: SidebarGroup[]
  /** Every row that is not delegated, in both modes and whatever the filter, search, collapse and caps
   *  show: the space a Resume, a drop and a bind write into, which hiding must not shrink. */
  rows: ReadonlyMap<string, RowPlace>
  /** Every folder's rank and seed, in both modes and regardless of search — what a folder drag or a
   *  bind needs, including for folders not currently rendered. */
  folders: ReadonlyMap<string, FolderRank>
  /** Every folder's display label, disambiguated across all of them, in both modes — a row's tooltip
   *  names its folder even in All mode, where no header does. */
  labels: ReadonlyMap<string, string>
  /** Every session that needs the user, in fully-expanded display order: the title bar bell's set,
   *  which reorders it for triage. Unaffected by the filter, search, collapse and caps, so nothing can
   *  hide one from it: a hidden conversation still reaches the user through the bell. */
  needsYou: string[]
  /** Rows the filter keeps off the rail that the search, if any, matches: what an empty rail names. */
  filteredOut: number
  /** The folders that start collapsed in this build — the input's, or the ones past the auto-expand
   *  index when it had none. */
  autoCollapsed: ReadonlySet<string>
}

export interface SidebarLimits {
  /** Rows shown per folder before Show more, pinned ones included. */
  folderCap: number
  /** Rows shown in All mode before Show more, pinned ones included. */
  allCap: number
  /** Unpinned rows a group shows however many are pinned — pins always show, so they cannot crowd
   *  the rest out entirely. */
  minUnpinned: number
  /** Folders past this index at launch start collapsed unless something says otherwise. */
  autoExpand: number
}

export const DEFAULT_SIDEBAR_LIMITS: SidebarLimits = { folderCap: 5, allCap: 40, minUnpinned: 3, autoExpand: 8 }

export interface SidebarInput {
  mode: SidebarMode
  groups: readonly ConversationGroup[]
  /** Live terminals. One without an indexed conversation still gets a row, placed by `projectRoot`. */
  ptys: readonly PtyState[]
  /** Pin order, top first. */
  pinned: readonly string[]
  /** Delegated Codex threads, which main withholds from every surface: no row, whatever the filter. */
  delegated: ReadonlySet<string>
  userHidden: UserHidden
  filter: RailFilter
  rowRanks: RankOverrides
  folderRanks: RankOverrides
  liveState: (pty: PtyState | null, meta: ConversationMeta, id: string) => LiveState | null
  /** Conversations on screen. Never withheld by a cap or the filter, and their folders are always
   *  expanded. */
  active: ReadonlySet<string>
  /** Stored per-folder collapse preferences. */
  collapsed: Readonly<Record<string, boolean>>
  /** The folders that start collapsed, fixed at launch (a model's `autoCollapsed`), so a folder that
   *  arrives above them or a folder drag collapses nothing. Null until then: the folders past
   *  `limits.autoExpand` in this build's order. */
  autoCollapsed: ReadonlySet<string> | null
  /** Folders expanded by navigation this session, which keep a folder open after focus moves on. */
  navExpanded: ReadonlySet<string>
  /** Folders the user collapsed while a conversation in them was active — the one thing that closes
   *  an active conversation's folder. Cleared for a folder when navigation next enters it. */
  activeCollapsed: ReadonlySet<string>
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

/**
 * A session that needs the user: asking, or finished and unread. The one predicate behind the title bar's
 * bell, a folder name going bold, and a row's title going bold — so the three always agree. Working
 * alone does not count: bold means "go look", and an agent working in the background is not a reason.
 */
export function needsYou(state: LiveState | null): boolean {
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
    if (seen.has(id) || input.delegated.has(id)) return
    seen.add(id)
    const pin = pinIndex.get(id)
    const by = hiddenBy(input.userHidden, id, root)
    out.push({
      row: {
        sessionId: id,
        pty,
        meta,
        pinned: pin !== undefined,
        liveState: input.liveState(pty, meta, id),
        rank: pin !== undefined ? -pin : rankOf(id, seed, input.rowRanks),
        hiddenBy: by,
        outside: !admits(input.filter, { hidden: by !== null, live: pty !== null })
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

function isCollapsed(input: SidebarInput, key: string, auto: ReadonlySet<string>, rows: readonly SidebarRow[]): boolean {
  if (input.search) return false
  // Derived, not stored: whatever path made a conversation active, its folder opens for it — unless
  // the user has collapsed it since, which only they can do.
  if (!input.activeCollapsed.has(key) && rows.some((r) => input.active.has(r.sessionId))) return false
  if (input.navExpanded.has(key)) return false
  if (Object.hasOwn(input.collapsed, key)) return input.collapsed[key]
  return auto.has(key)
}

function sortRows(rows: SidebarRow[]): SidebarRow[] {
  return rows.sort((a, b) => compareRanked({ id: a.sessionId, rank: a.rank }, { id: b.sessionId, rank: b.rank }))
}

function buildGroup(
  input: SidebarInput,
  key: string,
  label: string,
  auto: ReadonlySet<string>,
  all: SidebarRow[]
): SidebarGroup | null {
  // The filter applies here, where search does, rather than when rows are placed, so every row keeps
  // its rank and folder. Only what is on screen stays outside it: the selection never vanishes.
  const admitted = all.filter((r) => !r.outside || input.active.has(r.sessionId))
  const wantsAttention = admitted.some((r) => needsYou(r.liveState))
  const rows = input.search ? admitted.filter((r) => input.search!.has(r.sessionId)) : admitted
  // All mode is always exactly one group, even empty; a folder with nothing to show is dropped.
  if (rows.length === 0 && input.mode === 'folders') return null
  const header = input.mode === 'folders'
  const collapsed = header && isCollapsed(input, key, auto, rows)
  const pinned = sortRows(rows.filter((r) => r.pinned))
  const unpinned = sortRows(rows.filter((r) => !r.pinned))

  const cap = input.mode === 'all' ? input.limits.allCap : input.limits.folderCap
  let shown = unpinned
  let capped = unpinned.length
  if (!input.search) {
    // Capped by POSITION, so whether an idle row shows never depends on another row's liveness. Rows
    // past the cap that are live or on screen still render, after the rest, in their own order. Pins
    // always show and count toward the cap, down to the unpinned floor.
    const limit = Math.max(input.limits.minUnpinned, cap - pinned.length) + (input.revealed[key] ?? 0)
    capped = Math.min(limit, unpinned.length)
    shown = [
      ...unpinned.slice(0, limit),
      ...unpinned.slice(limit).filter((r) => r.pty !== null || input.active.has(r.sessionId))
    ]
  }
  const id = header ? key : '*'
  const blocks: SidebarBlock[] = []
  if (!collapsed) {
    if (pinned.length > 0) blocks.push({ id: `pin:${id}`, kind: 'pinned', rows: pinned, capped: pinned.length })
    if (shown.length > 0) blocks.push({ id: `un:${id}`, kind: 'unpinned', rows: shown, capped })
  }
  return {
    key,
    label,
    header,
    collapsed,
    blocks,
    withheld: collapsed ? 0 : unpinned.length - shown.length,
    wantsAttention,
    folderHidden: header && input.userHidden.folders.has(key)
  }
}

export function buildSidebar(input: SidebarInput): SidebarModel {
  const placed = placeRows(input)

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
  const folders = new Map<string, FolderRank>()
  for (const [root, b] of byRoot) folders.set(root, { rank: rankOf(root, b.seed, input.folderRanks), seed: b.seed })

  const folderOrder = [...folders].map(([id, f]) => ({ id, rank: f.rank })).sort(compareRanked).map((f) => f.id)
  // Hidden folders take none of the expanded places, so the first folders the user did not hide open.
  const auto =
    input.autoCollapsed ??
    new Set(folderOrder.filter((root) => !input.userHidden.folders.has(root)).slice(input.limits.autoExpand))
  const buckets =
    input.mode === 'all'
      ? [{ key: '', rows: placed.map((p) => p.row) }]
      : folderOrder.map((root) => ({ key: root, rows: byRoot.get(root)!.rows }))

  const labels = folderLabels([...byRoot.keys()])
  const groups: SidebarGroup[] = []
  for (const b of buckets) {
    const g = buildGroup(input, b.key, labels.get(b.key) ?? '', auto, b.rows)
    if (g) groups.push(g)
  }

  const order: string[] = []
  for (const b of buckets) {
    const rows = sortRows(b.rows.filter((r) => r.pinned)).concat(sortRows(b.rows.filter((r) => !r.pinned)))
    for (const r of rows) if (needsYou(r.liveState)) order.push(r.sessionId)
  }
  const rows = new Map<string, RowPlace>()
  let filteredOut = 0
  for (const p of placed) {
    const id = p.row.sessionId
    rows.set(id, { rank: p.row.rank, seed: p.seed, root: p.root, pinned: p.row.pinned })
    if (p.row.outside && !input.active.has(id) && (!input.search || input.search.has(id))) filteredOut++
  }
  return { groups, rows, folders, labels, needsYou: order, filteredOut, autoCollapsed: auto }
}

/**
 * The unpinned rows' ranks: the one space every drop and Resume writes into. Global rather than per
 * folder, so the same numbers order All mode and every folder at once. Pinned rows are excluded —
 * their rank is pin order, which is not a number an override can be compared with.
 */
export function rankSpace(model: SidebarModel): Ranked[] {
  const out: Ranked[] = []
  for (const [id, p] of model.rows) if (!p.pinned) out.push({ id, rank: p.rank })
  return out
}

/** The folders' ranks: the space a folder drop writes into. Every folder, rendered or not. */
export function folderRankSpace(model: SidebarModel): Ranked[] {
  return [...model.folders].map(([id, f]) => ({ id, rank: f.rank }))
}

/**
 * The neighbors a drop into an unpinned block really lands between. The block shows its capped rows
 * and then any live or open rows past the cap, which rank below every row it withholds — so two rows
 * adjacent on screen can straddle hidden ones, and a midpoint between them would hide a capped row
 * dropped there. A capped row lands directly below the row above it in the block's full order instead;
 * below a row that is itself past the cap, it lands below the last capped row, the lowest place that
 * still shows it. A row past the cap shows wherever it lands, so its drop is taken as it is.
 */
export function dropNeighbors(
  model: SidebarModel,
  block: SidebarBlock,
  draggedId: string,
  higherId: string | null,
  lowerId: string | null
): [higher: string | null, lower: string | null] {
  const at = block.rows.findIndex((r) => r.sessionId === draggedId)
  if (higherId === null || at >= block.capped) return [higherId, lowerId]
  // The capped rows other than the dragged one, top first.
  const capped = block.rows.slice(0, block.capped).filter((r) => r.sessionId !== draggedId)
  const higher = capped.some((r) => r.sessionId === higherId) ? higherId : capped[capped.length - 1]?.sessionId
  if (higher === undefined) return [higherId, lowerId]
  const root = block.id.slice('un:'.length)
  const full: Ranked[] = []
  for (const [id, p] of model.rows) {
    if (id !== draggedId && !p.pinned && (root === '*' || p.root === root)) full.push({ id, rank: p.rank })
  }
  const order = full.sort(compareRanked).map((e) => e.id)
  return [higher, order[order.indexOf(higher) + 1] ?? null]
}

/** The rows on screen, top to bottom — what keyboard navigation steps through. */
export function visibleRows(model: SidebarModel): SidebarRow[] {
  return model.groups.flatMap((g) => g.blocks.flatMap((b) => b.rows))
}

/**
 * A Resume's write: lift the row above every unpinned row, in every folder and in All mode at once.
 * Pinned rows are left where they are — their order is an arrangement the user made — and a row the
 * model does not hold (delegated, or not yet indexed) writes nothing. A hidden row is held.
 */
export function resumeWrites(model: SidebarModel, id: string, now: number): Record<string, number> {
  const place = model.rows.get(id)
  if (!place || place.pinned) return {}
  return { [id]: bumpRank(topRank(rankSpace(model)), now) }
}

/**
 * An Unpin's write: the row leaves the pinned rows for the top of the unpinned ones, where a Resume
 * would put it — not back where it ranked before it was pinned, which may be far down a folder or past
 * its cap. Taken while the row is still pinned, so the space it lands above is every other row. A row
 * that is not pinned, or that the model does not hold, writes nothing.
 */
export function unpinWrites(model: SidebarModel, id: string, now: number): Record<string, number> {
  const place = model.rows.get(id)
  if (!place || !place.pinned) return {}
  return { [id]: bumpRank(topRank(rankSpace(model)), now) }
}

/**
 * `buildSidebar`, holding in place every live row whose seed changed since `before` — a new Claude
 * conversation the index has just listed, whose stand-in row was seeded by its terminal's start (see
 * `holdRank`) — and its folder, when that row was what seeded it. Held in the SAME build, so the rail
 * never renders the row where its new seed would put it, not even for a frame the rail's reorder
 * animation would slide.
 *
 * `before` is the last model shown, or null when there is none to hold against: nothing shown yet, or
 * a catalog still loading, whose first load re-seeds every live row at its conversation's real start.
 * Only live rows can re-seed, and a stand-in is never pinned — nothing without an identity can be.
 * Returns the overrides the model was built from; the caller persists the entries its store lacks.
 */
export function buildSidebarHeld(
  before: SidebarModel | null,
  input: SidebarInput
): { model: SidebarModel; rowRanks: RankOverrides; folderRanks: RankOverrides } {
  const model = buildSidebar(input)
  let { rowRanks, folderRanks } = input
  if (before) {
    for (const p of input.ptys) {
      const was = before.rows.get(p.sessionId)
      const now = model.rows.get(p.sessionId)
      if (!was || !now || was.seed === now.seed) continue
      rowRanks = holdRank(rowRanks, p.sessionId, was.rank)
      const folder = before.folders.get(was.root)
      if (folder) folderRanks = absorbBindFolder(folderRanks, was.root, folder, was.seed)
    }
  }
  if (rowRanks === input.rowRanks && folderRanks === input.folderRanks) return { model, rowRanks, folderRanks }
  return { model: buildSidebar({ ...input, rowRanks, folderRanks }), rowRanks, folderRanks }
}

/** One conversation on screen and the folder it belongs to. */
export type ActivePlace = readonly [sessionId: string, root: string]

/**
 * The folders navigation just ENTERED: the folder of every conversation that became active. Keyed by
 * conversation, not folder, so moving to another conversation in a folder that was already active
 * still counts — the bell opening a row in a folder the user collapsed must show it. A folder
 * that merely stays active is not entered, so navigating the OTHER split pane leaves it alone.
 */
export function enteredFolders(before: readonly ActivePlace[], after: readonly ActivePlace[]): string[] {
  const was = new Set(before.map(([id]) => id))
  return [...new Set(after.filter(([id]) => !was.has(id)).map(([, root]) => root))]
}

/** `set` with `roots` added — the same set when nothing is new. */
export function withFolders(set: ReadonlySet<string>, roots: readonly string[]): ReadonlySet<string> {
  const add = roots.filter((r) => !set.has(r))
  return add.length === 0 ? set : new Set([...set, ...add])
}

/** `set` with `roots` removed — the same set when none were there. */
export function withoutFolders(set: ReadonlySet<string>, roots: readonly string[]): ReadonlySet<string> {
  if (!roots.some((r) => set.has(r))) return set
  const next = new Set(set)
  for (const r of roots) next.delete(r)
  return next
}

/**
 * The folder overrides after freezing every folder at its NEWEST row — the one-time freeze of folder
 * order the first time a profile runs this rail (see `onceTasks`). A folder that already carries an
 * override keeps it: it was placed by a drag or a bind. Written as overrides, so the order is fixed
 * from then on and nothing moves when a conversation later starts in a folder. Folders first seen
 * after the freeze are seeded by their earliest row, which for a brand-new folder is also its newest.
 */
export function freezeFoldersByNewest(model: SidebarModel, stored: RankOverrides): Record<string, number> {
  const newest: Record<string, number> = {}
  for (const p of model.rows.values()) {
    if (!Object.hasOwn(newest, p.root) || p.seed > newest[p.root]) newest[p.root] = p.seed
  }
  return { ...newest, ...stored }
}
