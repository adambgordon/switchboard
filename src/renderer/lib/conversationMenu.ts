import type { ConversationMenuAction, ConversationMenuEntry } from '@shared/types'

/**
 * The menu for a conversation — ONE list, however it is reached. The rail row's ⋮ menu renders it and
 * the tab's right-click menu hands it to main to build natively, so the two cannot drift: the same
 * conversation offers the same commands, under the same words, in the same order, from either place.
 * A tab adds only what is about tabs (closing them, and reopening what was closed).
 *
 * The groups, top to bottom: start it, where it shows, filing (pin, hide, read) and naming, (tabs)
 * closing, end it.
 * Resume heads the menu because it is the command a finished conversation's menu is most often opened
 * for; Stop is last because it is destructive, and red.
 *
 * A menu opened on a multi-selection — picked rail rows, or a tab group — is the same list for the
 * group, minus what only makes sense for one: no Resume, no Rename, no Session details. Every command
 * it keeps acts on the targets it would actually change, and says how many.
 */

/** Where "to the side" lands: a new pane on the right, or the pane that already exists on one side. */
export type SidePlace = 'right' | 'rightPane' | 'leftPane'

/** One conversation a group menu acts on, as the menu needs to know it. */
export interface MenuTarget {
  id: string
  /** An indexed conversation stands behind it — what pin, hide and read act on (see `linked`). */
  linked: boolean
  /** It can be placed: a terminal that stands for no conversation has nowhere else to show. */
  movable: boolean
  live: boolean
  pinned: boolean
  unread: boolean
  hidden: 'folder' | 'self' | null
}

/**
 * A multi-selection, resolved per command: for each command, the targets it would change, in the
 * group's order. The label's count and the ids the command runs on come from this one record, so
 * "Pin 2" cannot pin three.
 */
export interface MenuGroup {
  /** Everything picked — what a tab group's Close acts on. */
  size: number
  /** What the where-to commands place. */
  move: string[]
  pin: string[]
  unpin: string[]
  hide: string[]
  unhide: string[]
  markRead: string[]
  markUnread: string[]
  stop: string[]
}

/**
 * The per-command targets of a group. Pin, hide and read act only on what has a conversation behind
 * it, as the single menu offers them only there; read also needs it live, since a finished
 * conversation has no dot to mark. A row hidden by its folder is neither hidden nor unhidden here —
 * only its folder can bring it back. Stop acts on every running terminal, linked or not.
 */
export function menuGroup(targets: readonly MenuTarget[]): MenuGroup {
  const ids = (keep: (t: MenuTarget) => boolean): string[] => targets.filter(keep).map((t) => t.id)
  return {
    size: targets.length,
    move: ids((t) => t.movable),
    pin: ids((t) => t.linked && !t.pinned),
    unpin: ids((t) => t.linked && t.pinned),
    hide: ids((t) => t.linked && t.hidden === null),
    unhide: ids((t) => t.linked && t.hidden === 'self'),
    markRead: ids((t) => t.linked && t.live && t.unread),
    markUnread: ids((t) => t.linked && t.live && !t.unread),
    stop: ids((t) => t.live)
  }
}

export interface ConversationMenuState {
  surface: 'row' | 'tab'
  /** The multi-selection the menu was opened on, or null for a menu about this one conversation. */
  group: MenuGroup | null
  /** There is an indexed conversation behind it. A chooser tab, a terminal not yet bound to one, and a
   *  new conversation before its first message have none. */
  linked: boolean
  live: boolean
  pinned: boolean
  unread: boolean
  /** Why the user's hide covers it, or null (`hiddenBy`). Hidden by its folder, only the folder can
   *  bring it back. */
  hidden: 'folder' | 'self' | null
  /** Where "to the side" would put it, or null when it cannot go there. */
  side: SidePlace | null
  newWindow: boolean
  /** This window already holds a tab for it, so the where-to commands move it rather than open it.
   *  Always so for a tab. */
  hasTabHere: boolean
  /** Tab only: other tabs exist to close. */
  closeOthers: boolean
  /** Tab only: how many tabs Reopen would bring back — the window's newest reopenable close — or 0. */
  reopen: number
}

const SIDE_TARGET: Record<SidePlace, { open: string; move: string }> = {
  right: { open: 'to the right', move: 'to the right' },
  rightPane: { open: 'in right pane', move: 'to right pane' },
  leftPane: { open: 'in left pane', move: 'to left pane' }
}

/** `3 tabs`, `1 conversation`. */
function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function conversationMenu(s: ConversationMenuState): ConversationMenuEntry[] {
  const g = s.group
  const move = s.surface === 'tab' || s.hasTabHere
  const item = (action: ConversationMenuAction, label: string, danger = false): ConversationMenuEntry =>
    danger ? { action, label, danger } : { action, label }

  const groups: ConversationMenuEntry[][] = []
  if (!g && s.linked && !s.live) groups.push([item('resume', 'Resume session')])

  const where: ConversationMenuEntry[] = []
  // A group names how many it places, by what they are on the surface it was opened from. With
  // nothing in it that can be placed, there is nothing to say where.
  const what = g ? ` ${counted(g.move.length, s.surface === 'tab' ? 'tab' : 'conversation')}` : ''
  if (!g || g.move.length > 0) {
    if (s.side) {
      const t = SIDE_TARGET[s.side]
      where.push(item('toSide', move ? `Move${what} ${t.move}` : `Open${what} ${t.open}`))
    }
    if (s.newWindow) {
      where.push(item('newWindow', move ? `Move${what} to new window` : `Open${what} in new window`))
    }
  }
  groups.push(where)

  if (g) {
    // Each is a SET, never a toggle, offered in the direction that changes something: Pin while any is
    // unpinned, Unpin once all are, and the same for hide and read. Counted by what it would change,
    // not by the selection.
    const filing: ConversationMenuEntry[] = []
    if (g.pin.length > 0) filing.push(item('pin', `Pin ${g.pin.length}`))
    else if (g.unpin.length > 0) filing.push(item('unpin', `Unpin ${g.unpin.length}`))
    if (g.hide.length > 0) filing.push(item('hide', `Hide ${g.hide.length}`))
    else if (g.unhide.length > 0) filing.push(item('unhide', `Unhide ${g.unhide.length}`))
    if (g.markUnread.length > 0) filing.push(item('markUnread', `Mark ${g.markUnread.length} as unread`))
    else if (g.markRead.length > 0) filing.push(item('markRead', `Mark ${g.markRead.length} as read`))
    groups.push(filing)
  } else if (s.linked) {
    const filing = [item(s.pinned ? 'unpin' : 'pin', s.pinned ? 'Unpin' : 'Pin')]
    filing.push(
      s.hidden === 'folder'
        ? item('unhideFolder', 'Unhide folder')
        : s.hidden === 'self'
          ? item('unhide', 'Unhide')
          : item('hide', 'Hide')
    )
    if (s.live) filing.push(item(s.unread ? 'markRead' : 'markUnread', s.unread ? 'Mark as read' : 'Mark as unread'))
    filing.push(item('rename', 'Rename…'), item('details', 'Session details…'))
    groups.push(filing)
  }

  if (s.surface === 'tab') {
    const close = [item('close', g ? `Close ${counted(g.size, 'tab')}` : 'Close tab')]
    if (s.closeOthers) close.push(item('closeOthers', 'Close other tabs'))
    // It acts on the window's history, not on this tab, so it counts what it would bring back rather
    // than the selection.
    if (s.reopen > 0) {
      close.push(item('reopenClosed', s.reopen > 1 ? `Reopen ${s.reopen} closed tabs` : 'Reopen closed tab'))
    }
    groups.push(close)
  }

  if (g) {
    if (g.stop.length > 0) groups.push([item('stop', `Stop ${counted(g.stop.length, 'session')}`, true)])
  } else if (s.live) groups.push([item('stop', 'Stop session', true)])

  return joinGroups(groups)
}

/** A folder header's menu. Hiding a folder hides every conversation in it, in both modes. */
export function folderMenu(hidden: boolean): ConversationMenuEntry[] {
  return [hidden ? { action: 'unhideFolder', label: 'Unhide folder' } : { action: 'hideFolder', label: 'Hide folder' }]
}

function joinGroups(groups: ConversationMenuEntry[][]): ConversationMenuEntry[] {
  const out: ConversationMenuEntry[] = []
  for (const g of groups) {
    if (g.length === 0) continue
    if (out.length > 0) out.push({ separator: true })
    out.push(...g)
  }
  return out
}
