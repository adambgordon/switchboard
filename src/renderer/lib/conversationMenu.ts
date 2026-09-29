import type { ConversationMenuAction, ConversationMenuEntry } from '@shared/types'

/**
 * The menu for a conversation — ONE list, however it is reached. The rail row's ⋮ menu renders it and
 * the tab's right-click menu hands it to main to build natively, so the two cannot drift: the same
 * conversation offers the same commands, under the same words, in the same order, from either place.
 * A tab adds only what is about tabs (closing them, and reopening what was closed).
 *
 * The groups, top to bottom: start it · where it shows · filing and naming · (tabs) closing · end it.
 * Resume heads the menu because it is the command a finished conversation's menu is most often opened
 * for; Stop is last because it is destructive, and red.
 */

/** Where "to the side" lands: a new pane on the right, or the pane that already exists on one side. */
export type SidePlace = 'right' | 'rightPane' | 'leftPane'

export interface ConversationMenuState {
  surface: 'row' | 'tab'
  /** How many tabs the where-to and close commands act on: more than 1 only for a multi-selection. */
  count: number
  /** There is a conversation behind it. A chooser tab, or a terminal not yet bound to one, has none. */
  linked: boolean
  live: boolean
  pinned: boolean
  unread: boolean
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

export function conversationMenu(s: ConversationMenuState): ConversationMenuEntry[] {
  const many = s.count > 1
  const move = s.surface === 'tab' || s.hasTabHere
  const what = many ? ` ${s.count} tabs` : ''
  const item = (action: ConversationMenuAction, label: string, danger = false): ConversationMenuEntry =>
    danger ? { action, label, danger } : { action, label }

  const groups: ConversationMenuEntry[][] = []
  if (!many && s.linked && !s.live) groups.push([item('resume', 'Resume session')])

  const where: ConversationMenuEntry[] = []
  if (s.side) {
    const t = SIDE_TARGET[s.side]
    where.push(item('toSide', move ? `Move${what} ${t.move}` : `Open ${t.open}`))
  }
  if (s.newWindow) where.push(item('newWindow', move ? `Move${what} to new window` : 'Open in new window'))
  groups.push(where)

  if (!many && s.linked) {
    const filing = [item(s.pinned ? 'unpin' : 'pin', s.pinned ? 'Unpin' : 'Pin')]
    if (s.live) filing.push(item(s.unread ? 'markRead' : 'markUnread', s.unread ? 'Mark as read' : 'Mark as unread'))
    filing.push(item('rename', 'Rename…'), item('details', 'Session details…'))
    groups.push(filing)
  }

  if (s.surface === 'tab') {
    const close = [item('close', many ? `Close${what}` : 'Close tab')]
    if (s.closeOthers) close.push(item('closeOthers', 'Close other tabs'))
    // It acts on the window's history, not on this tab, so it counts what it would bring back rather
    // than the selection.
    if (s.reopen > 0) {
      close.push(item('reopenClosed', s.reopen > 1 ? `Reopen ${s.reopen} closed tabs` : 'Reopen closed tab'))
    }
    groups.push(close)
  }

  if (!many && s.live) groups.push([item('stop', 'Stop session', true)])

  const out: ConversationMenuEntry[] = []
  for (const g of groups) {
    if (g.length === 0) continue
    if (out.length > 0) out.push({ separator: true })
    out.push(...g)
  }
  return out
}
