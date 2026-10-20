/**
 * Picking several rail rows at once, so one command can act on all of them.
 *
 * The same algebra as a tab selection (`tabSelection.ts`), reused rather than restated: the rail is a
 * single list, so its selection is a tab selection held in one fixed scope. Its rules carry over, and
 * so do their reasons — empty means "no multi-selection" rather than "nothing selected", the ⇧ anchor
 * is a session id because rows move under a selection, and a lone survivor of a prune is kept for its
 * anchor. What is the rail's own is the list a range walks: `visibleRows`, every row on screen, across
 * folders and blocks, top to bottom.
 *
 * ⌘ and ⇧ only ever change the selection. They never open a conversation: landing on one marks it
 * read and makes it the rail's selected row, so a pick that navigated would move the very row a range
 * is taken from.
 */
import {
  NO_SELECTION,
  extendSelection,
  pruneSelection,
  retargetSelection,
  toggleSelected,
  type TabSelection
} from './tabSelection'
import { menuGroup, type MenuGroup, type MenuTarget } from './conversationMenu'
import { isUnlinkedRow } from './rowIdentity'
import type { SidebarRow } from './sidebarModel'

export type RailSelection = TabSelection

export const NO_PICKS: RailSelection = NO_SELECTION

/** The one scope a rail selection lives in. Tab selections are separate state, so it collides with none. */
const RAIL = 0

/**
 * What a first ⌘-click seeds the selection with, and a first ⇧-click ranges from: the rail's selected
 * row, but only while the rail shows it. A selected conversation can sit off the rail — filtered out,
 * in a collapsed folder — and a pick nobody can see would be acted on without being shown.
 */
export function pickSeed(selectedId: string | null, order: readonly string[]): string | null {
  return selectedId !== null && order.includes(selectedId) ? selectedId : null
}

/** ⌘-click: add or remove one row. See `toggleSelected`. */
export function togglePick(sel: RailSelection, seed: string | null, id: string): RailSelection {
  return toggleSelected(sel, RAIL, seed, id)
}

/** ⇧-click: the run from the anchor — else the seed — to this row, in rail order. See `extendSelection`. */
export function extendPicks(
  sel: RailSelection,
  order: readonly string[],
  id: string,
  seed: string | null
): RailSelection {
  return extendSelection(sel, RAIL, [...order], id, seed)
}

/**
 * Drop every pick the rail no longer shows. A row leaves the screen without anyone deselecting it — a
 * filter, a search, a collapse, Show less, a hide from another window — and a command must never act
 * on a row the user cannot see. Returns the input by identity when nothing went.
 */
export function prunePicks(sel: RailSelection, order: readonly string[]): RailSelection {
  return pruneSelection(sel, [[...order]])
}

/** A placeholder terminal bound to its real conversation: its pick follows it. See `retargetSelection`. */
export function retargetPicks(sel: RailSelection, from: string, to: string): RailSelection {
  return retargetSelection(sel, from, to)
}

/**
 * The rows a command invoked on `id` acts on, in rail order: the picks, when `id` is one of them, and
 * otherwise `id` alone — invoking a command on a row outside the selection is about that row.
 */
export function pickedTargets(picked: ReadonlySet<string>, id: string, order: readonly string[]): string[] {
  if (!picked.has(id)) return [id]
  return order.filter((x) => picked.has(x))
}

/**
 * The rows a drag from `pressedId` carries: the picks in the pressed row's own block, in that block's
 * order. A drag never leaves its block, so picks elsewhere stay where they are, and stay picked. A
 * press on a row outside the selection carries that row alone.
 */
export function dragCarry(picked: ReadonlySet<string>, pressedId: string, blockOrder: readonly string[]): string[] {
  if (!picked.has(pressedId)) return [pressedId]
  return blockOrder.filter((x) => picked.has(x))
}

/** A rail row as the conversation menu needs to know it — for one row's menu and for a group's alike. */
export function railMenuTarget(row: SidebarRow): MenuTarget {
  // A row that stands for no conversation can only be stopped. One whose conversation is not indexed
  // yet — a new one before its first message — can also be placed, but has nothing to pin or mark.
  const movable = !isUnlinkedRow(row.pty, row.meta)
  return {
    id: row.sessionId,
    linked: movable && !row.meta.provisional,
    movable,
    live: !!row.pty,
    pinned: row.pinned,
    unread: row.liveState === 'awaiting' || row.liveState === 'asking',
    hidden: row.hiddenBy
  }
}

/**
 * The group a menu opened on `id` is about, or null when it is about `id` alone: `rows` is the rail
 * on screen, top to bottom. One pick is not a group — it is the anchor a ⇧-click ranges from — so a
 * menu opened on it is that row's own.
 */
export function railMenuGroup(
  picked: ReadonlySet<string>,
  id: string,
  rows: readonly SidebarRow[]
): MenuGroup | null {
  if (!picked.has(id)) return null
  const group = rows.filter((r) => picked.has(r.sessionId))
  return group.length < 2 ? null : menuGroup(group.map(railMenuTarget))
}
