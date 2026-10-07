/**
 * Manual ordering for the rail, as SPARSE rank overrides. Pure and DOM-free, so it is unit-tested.
 *
 * Every row has a rank and the rail sorts descending. A row nobody has touched ranks at its SEED — a
 * fixed number derived from the row itself (its conversation's start, see `sidebarModel`) — and
 * stores nothing. Only five events write, each one key: a drag writes the dropped row's new rank, a
 * Resume lifts its row above everything, an Unpin lifts its row the same way, a placeholder terminal
 * binding to its real conversation hands its rank to the real id, and a new conversation's first
 * index keeps the rank its terminal's stand-in row had. Nothing derived from the catalog is ever
 * written, so rendering
 * against a partial or empty catalog (startup, a second window) cannot lose a position.
 *
 * Ranks are ms timestamps, so a rank space is global: the same numbers order the All list and every
 * folder at once. A drop inside one folder writes a number that also places the row among the other
 * folders' rows in All mode, which is what keeps the two views of one order consistent.
 *
 * The one property this depends on is that seeds are STABLE. A seed that drifts silently moves every
 * row that was never dragged.
 */

export interface Ranked {
  id: string
  rank: number
}

export type RankOverrides = Readonly<Record<string, number>>

export const ROW_RANK_KEY = 'switchboard.rowRank'
export const FOLDER_RANK_KEY = 'switchboard.folderRank'

export function rankOf(id: string, seed: number, overrides: RankOverrides): number {
  // `hasOwn`, not `?? `: a parsed JSON object inherits `Object.prototype`, and an id that names one of
  // its members must not resolve to a function.
  return Object.hasOwn(overrides, id) ? overrides[id] : seed
}

/** Descending by rank; ties broken by id so every caller agrees on one total order. */
export function compareRanked(a: Ranked, b: Ranked): number {
  if (a.rank !== b.rank) return b.rank - a.rank
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** The highest rank in a space, or null when it is empty. */
export function topRank(space: readonly Ranked[]): number | null {
  let top: number | null = null
  for (const e of space) if (top === null || e.rank > top) top = e.rank
  return top
}

/**
 * A Resume's rank: above every row, and never behind the clock, so a conversation started after the
 * Resume still lands above it — the list reads "most recently started or resumed first". `topRank` is
 * the highest rank in the space, or null when it is empty.
 */
export function bumpRank(topRank: number | null, now: number): number {
  return topRank === null ? now : Math.max(now, topRank + 1)
}

/**
 * The override writes that drop `draggedId` between two neighbors in its block — `higherId` directly
 * above the drop point, `lowerId` directly below, either null at a block's edge.
 *
 * `space` is every entry of the rank space, in any order, and may include the dragged row. The
 * neighbors are the dragged row's neighbors WITHIN ITS BLOCK, which in Folders mode need not be
 * adjacent in the space: other folders' rows can sit between them, and the midpoint lands among
 * those, which is correct for All mode.
 *
 * Normally one key: the neighbors' midpoint; at the top, like a Resume (above the row below it and
 * never behind the clock); at the bottom, one below the row above it. When the neighbors are too close
 * for a float between them — repeated drops into one gap halve it each time, and at timestamp
 * magnitudes that runs out after a few dozen — the rows around the gap are re-spaced evenly between
 * the nearest ranks that have room. That happens in the global space rather than the block, so every
 * row keeps its position relative to every other row in both modes; it may write rows that were never
 * dragged, which pins them where they already are.
 */
export function dropWrites(
  space: readonly Ranked[],
  draggedId: string,
  higherId: string | null,
  lowerId: string | null,
  now: number
): Record<string, number> {
  const items = space.filter((e) => e.id !== draggedId).sort(compareRanked)
  const higher = higherId === null ? null : items.find((e) => e.id === higherId) ?? null
  const lower = lowerId === null ? null : items.find((e) => e.id === lowerId) ?? null
  if (!higher && !lower) return {}
  if (!higher) return { [draggedId]: bumpRank(lower!.rank, now) }
  if (!lower) return { [draggedId]: higher.rank - 1 }
  const mid = higher.rank / 2 + lower.rank / 2
  if (mid < higher.rank && mid > lower.rank) return { [draggedId]: mid }
  return respace(items, items.indexOf(lower), draggedId)
}

/**
 * Re-rank a window of `items` (sorted, dragged row excluded) around insertion index `at`, inserting
 * `draggedId` there. Widens symmetrically until evenly spaced values fit strictly between the ranks
 * bounding the window. At a list end the missing bound is taken one step per value past the extreme
 * rank, so once the window spans everything the spacing is at least one and always representable.
 */
function respace(items: readonly Ranked[], at: number, draggedId: string): Record<string, number> {
  const n = items.length
  for (let radius = 1; ; radius++) {
    const lo = Math.max(0, at - radius)
    const hi = Math.min(n, at + radius)
    const ids = [...items.slice(lo, at).map((e) => e.id), draggedId, ...items.slice(at, hi).map((e) => e.id)]
    const k = ids.length
    const upper = lo > 0 ? items[lo - 1].rank : items[0].rank + k + 1
    const lowerBound = hi < n ? items[hi].rank : items[n - 1].rank - (k + 1)
    const values = ids.map((_, i) => upper - ((upper - lowerBound) * (i + 1)) / (k + 1))
    const fits = values.every((v, i) => v < (i === 0 ? upper : values[i - 1])) && values[k - 1] > lowerBound
    if (fits) {
      const current = new Map(items.slice(lo, hi).map((e) => [e.id, e.rank]))
      const writes: Record<string, number> = {}
      ids.forEach((id, i) => {
        if (current.get(id) !== values[i]) writes[id] = values[i]
      })
      return writes
    }
    if (lo === 0 && hi === n) throw new Error('rowRank: no representable spacing')
  }
}

/**
 * A placeholder terminal bound to its real conversation: the real id takes the placeholder's
 * EFFECTIVE rank — its override if it was dragged, else its seed. Transferring nothing when it was
 * never dragged would be wrong: the real conversation's own seed (its first message) is later than
 * the placeholder's (the terminal's start), and a row started in between would jump past it.
 *
 * `overrides` is the STORED map, re-read at the time of the write, and every window folds the same
 * bind into it. So the fold reads the placeholder's override from the store rather than trusting
 * `seenRank` — what this window last rendered — and it is idempotent: a store where the placeholder
 * has no override but the real id does is exactly what an earlier window's transfer leaves, and it is
 * left alone. Only when neither id has an override does `seenRank` (the placeholder's seed) apply.
 * A dragged placeholder's position beats one the real id carries: the real id can only have been
 * placed in the instant between its first index and the bind, beside the row the user was watching.
 *
 * A CORRECTION — a terminal moving between two real conversations — must never come here: both ids
 * are durable rows at positions of their own, and this would destroy one. See `bindActions`.
 */
export function absorbBind(
  overrides: RankOverrides,
  seenRank: number,
  placeholderId: string,
  realId: string
): Record<string, number> {
  if (placeholderId === realId) return overrides as Record<string, number>
  const dragged = Object.hasOwn(overrides, placeholderId)
  if (!dragged && Object.hasOwn(overrides, realId)) return overrides as Record<string, number>
  const next: Record<string, number> = { ...overrides }
  delete next[placeholderId]
  next[realId] = dragged ? overrides[placeholderId] : seenRank
  return next
}

/**
 * A row whose seed changed under it keeps the rank it was showing — the same-id sibling of
 * `absorbBind`. A new Claude conversation's row is a stand-in seeded by its terminal's start until the
 * index lists it, and the index re-seeds it at its first message, later; without this it would jump
 * past every row started or resumed in between. A row that already carries an override was placed by
 * the user (or by another window's identical hold), and is left alone.
 */
export function holdRank(overrides: RankOverrides, id: string, shownRank: number): Record<string, number> {
  if (Object.hasOwn(overrides, id)) return overrides as Record<string, number>
  return { ...overrides, [id]: shownRank }
}

/**
 * The folder half of an initial bind. A folder is seeded by its earliest row, and a brand-new
 * folder's earliest row can be the placeholder itself — seeded by its terminal's start. Once bound,
 * that row's seed becomes the real conversation's first message, later than the terminal's start, so
 * the folder's seed would rise and it could drop below a folder started in between. When the
 * placeholder is what holds the folder's seed, freeze the folder where it stands.
 *
 * Nothing is written when the folder already carries an override (a user-set position the bind must
 * not disturb) or when an older row holds its seed (the bind cannot move it).
 */
export function absorbBindFolder(
  folderOverrides: RankOverrides,
  root: string,
  folder: { rank: number; seed: number },
  placeholderSeed: number
): Record<string, number> {
  if (Object.hasOwn(folderOverrides, root) || placeholderSeed > folder.seed) {
    return folderOverrides as Record<string, number>
  }
  return { ...folderOverrides, [root]: folder.rank }
}

/** Read a stored override map, keeping only finite numeric entries. Anything malformed reads as empty. */
export function parseRanks(raw: string | null): Record<string, number> {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, number> = {}
  for (const [id, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[id] = v
  }
  return out
}
