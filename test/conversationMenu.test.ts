import { describe, expect, it } from 'vitest'
import {
  conversationMenu,
  folderMenu,
  menuGroup,
  type ConversationMenuState,
  type MenuTarget
} from '../src/renderer/lib/conversationMenu'
import type { ConversationMenuEntry } from '../src/shared/types'

/**
 * The conversation menu is ONE list for the rail row and the tab. These pin its order, its words, and
 * that the two surfaces differ only by the tab's own Close group.
 */

const base: ConversationMenuState = {
  surface: 'row',
  group: null,
  linked: true,
  live: false,
  pinned: false,
  unread: false,
  hidden: null,
  side: 'right',
  newWindow: true,
  hasTabHere: false,
  closeOthers: false,
  reopen: 0
}
const menu = (over: Partial<ConversationMenuState>): ConversationMenuEntry[] => conversationMenu({ ...base, ...over })
// '—' for a divider, a trailing '!' for a destructive command: the whole shape in one comparable line.
const shape = (entries: ConversationMenuEntry[]): string[] =>
  entries.map((e) => ('separator' in e ? '—' : `${e.label}${e.danger ? '!' : ''}`))
// An indexed, finished, unpinned, unhidden conversation, unless told otherwise.
const target = (id: string, over: Partial<MenuTarget> = {}): MenuTarget => ({
  id,
  linked: true,
  movable: true,
  live: false,
  pinned: false,
  unread: false,
  hidden: null,
  ...over
})

describe('the row menu', () => {
  it('a finished conversation: Resume first, then where it shows, then filing — no Stop', () => {
    expect(shape(menu({}))).toEqual([
      'Resume session',
      '—',
      'Open to the right',
      'Open in new window',
      '—',
      'Pin',
      'Hide',
      'Rename…',
      'Session details…'
    ])
  })

  it('a running one: no Resume, a read toggle, and Stop last, marked destructive', () => {
    expect(shape(menu({ live: true, side: 'rightPane' }))).toEqual([
      'Open in right pane',
      'Open in new window',
      '—',
      'Pin',
      'Hide',
      'Mark as unread',
      'Rename…',
      'Session details…',
      '—',
      'Stop session!'
    ])
  })

  it('says Move when this window already holds its tab', () => {
    expect(shape(menu({ hasTabHere: true, side: 'leftPane' })).slice(2, 4)).toEqual(['Move to left pane', 'Move to new window'])
    expect(shape(menu({ hasTabHere: true })).slice(2, 3)).toEqual(['Move to the right'])
  })

  it('offers each toggle in the direction it would go', () => {
    const labels = shape(menu({ live: true, pinned: true, unread: true }))
    expect(labels).toContain('Unpin')
    expect(labels).toContain('Mark as read')
    expect(labels).not.toContain('Pin')
    expect(labels).not.toContain('Mark as unread')
  })

  it('offers Unhide for a conversation hidden by itself, and its folder for one hidden by its folder', () => {
    const filing = (hidden: ConversationMenuState['hidden']): string[] =>
      menu({ hidden, side: null, newWindow: false }).flatMap((e) => ('separator' in e ? [] : [`${e.action}:${e.label}`]))
    expect(filing('self')).toEqual(['resume:Resume session', 'pin:Pin', 'unhide:Unhide', 'rename:Rename…', 'details:Session details…'])
    expect(filing('folder')).toEqual([
      'resume:Resume session',
      'pin:Pin',
      'unhideFolder:Unhide folder',
      'rename:Rename…',
      'details:Session details…'
    ])
  })

  it('drops the where-to group, and its divider, when there is nowhere to send it', () => {
    expect(shape(menu({ side: null, newWindow: false }))).toEqual(['Resume session', '—', 'Pin', 'Hide', 'Rename…', 'Session details…'])
  })

  it('a terminal with no conversation yet can only be stopped', () => {
    expect(shape(menu({ linked: false, live: true, side: null, newWindow: false }))).toEqual(['Stop session!'])
  })
})

describe('the tab menu', () => {
  it('is the row menu with the tab’s Close group before Stop', () => {
    const state = { live: true, side: 'rightPane' as const, hasTabHere: true }
    const row = shape(menu(state))
    const tab = shape(menu({ ...state, surface: 'tab', closeOthers: true }))
    expect(tab).toEqual([...row.slice(0, -2), '—', 'Close tab', 'Close other tabs', '—', 'Stop session!'])
  })

  it('always says Move — a tab is already here', () => {
    expect(shape(menu({ surface: 'tab', hasTabHere: false })).slice(2, 4)).toEqual(['Move to the right', 'Move to new window'])
  })

  it('a finished conversation’s tab ends with its Close group', () => {
    expect(shape(menu({ surface: 'tab', side: 'leftPane', closeOthers: false }))).toEqual([
      'Resume session',
      '—',
      'Move to left pane',
      'Move to new window',
      '—',
      'Pin',
      'Hide',
      'Rename…',
      'Session details…',
      '—',
      'Close tab'
    ])
  })

  it('a selection of several offers what applies to a group, and counts what each would change', () => {
    const group = menuGroup([
      target('a', { live: true }),
      target('b', { live: true, pinned: true }),
      target('c', { live: true, unread: true })
    ])
    expect(shape(menu({ surface: 'tab', group, live: true, closeOthers: true }))).toEqual([
      'Move 3 tabs to the right',
      'Move 3 tabs to new window',
      '—',
      'Pin 2',
      'Hide 3',
      'Mark 2 as unread',
      '—',
      'Close 3 tabs',
      'Close other tabs',
      '—',
      'Stop 3 sessions!'
    ])
  })

  it('closes every tab in the group, counting what it closes rather than what it can place', () => {
    const group = menuGroup([target('a'), target('b', { movable: false }), target('c', { movable: false })])
    expect(shape(menu({ surface: 'tab', group }))).toContain('Close 3 tabs')
  })

  it('…whether they are running or not: a selection of finished ones offers no Resume, read or Stop', () => {
    const group = menuGroup([target('a'), target('b')])
    expect(shape(menu({ surface: 'tab', group, live: false, closeOthers: false }))).toEqual([
      'Move 2 tabs to the right',
      'Move 2 tabs to new window',
      '—',
      'Pin 2',
      'Hide 2',
      '—',
      'Close 2 tabs'
    ])
  })

  it('a chooser can only be closed', () => {
    expect(shape(menu({ surface: 'tab', linked: false, side: null, newWindow: false, closeOthers: true }))).toEqual([
      'Close tab',
      'Close other tabs'
    ])
  })

  it('offers Reopen last in its Close group, counting what it would bring back — not the selection', () => {
    // A selection of 2 and a reopen of 3, so a label built from the wrong count cannot pass.
    const group = menuGroup([target('a', { linked: false }), target('b', { linked: false })])
    expect(shape(menu({ surface: 'tab', group, closeOthers: true, reopen: 3 }))).toEqual([
      'Move 2 tabs to the right',
      'Move 2 tabs to new window',
      '—',
      'Close 2 tabs',
      'Close other tabs',
      'Reopen 3 closed tabs'
    ])
    expect(shape(menu({ surface: 'tab', side: null, newWindow: false, linked: false, reopen: 1 }))).toEqual([
      'Close tab',
      'Reopen closed tab'
    ])
  })

  it('offers no Reopen with nothing to reopen, nor on a rail row', () => {
    expect(shape(menu({ surface: 'tab', side: null, newWindow: false, linked: false, reopen: 0 }))).toEqual(['Close tab'])
    expect(shape(menu({ reopen: 2 }))).toEqual(shape(menu({})))
  })

  it('names each command for what it does', () => {
    const actions = menu({ surface: 'tab', live: true, closeOthers: true, reopen: 1 }).flatMap((e) => ('separator' in e ? [] : [e.action]))
    expect(actions).toEqual(['toSide', 'newWindow', 'pin', 'hide', 'markUnread', 'rename', 'details', 'close', 'closeOthers', 'reopenClosed', 'stop'])
  })
})

describe('menuGroup', () => {
  it('pins only what has a conversation and is not pinned, and unpins what is', () => {
    const g = menuGroup([
      target('c'),
      target('a', { pinned: true }),
      target('b', { linked: false }),
      target('d', { linked: false, pinned: true })
    ])
    expect(g.pin).toEqual(['c'])
    expect(g.unpin).toEqual(['a'])
  })

  it('hides what is not hidden, unhides what hid itself, and leaves a folder’s hide to its folder', () => {
    const g = menuGroup([
      target('d'),
      target('a', { hidden: 'self' }),
      target('b', { hidden: 'folder' }),
      target('c', { linked: false })
    ])
    expect(g.hide).toEqual(['d'])
    expect(g.unhide).toEqual(['a'])
  })

  it('marks read or unread only a running conversation, never a terminal that stands for none', () => {
    const g = menuGroup([
      target('e', { live: true, unread: true }),
      target('a', { live: true }),
      target('b'),
      target('c', { unread: true }),
      target('d', { live: true, linked: false }),
      target('f', { live: true, linked: false, unread: true })
    ])
    expect(g.markRead).toEqual(['e'])
    expect(g.markUnread).toEqual(['a'])
  })

  it('stops every running terminal, linked or not', () => {
    const g = menuGroup([target('c', { live: true }), target('a'), target('b', { live: true, linked: false })])
    expect(g.stop).toEqual(['c', 'b'])
  })

  it('places only what can be placed, and counts everything for a close', () => {
    const g = menuGroup([target('c'), target('a', { movable: false, linked: false, live: true }), target('b')])
    expect(g.move).toEqual(['c', 'b'])
    expect(g.size).toBe(3)
  })
})

describe('a group of rail rows', () => {
  const rows = (...targets: MenuTarget[]) => menu({ group: menuGroup(targets) })

  it('names what it places and counts it, and offers no Resume, Rename or details', () => {
    expect(shape(rows(target('a'), target('b'), target('c')))).toEqual([
      'Open 3 conversations to the right',
      'Open 3 conversations in new window',
      '—',
      'Pin 3',
      'Hide 3'
    ])
  })

  it('says Move when this window already holds every tab', () => {
    const group = menuGroup([target('a'), target('b')])
    expect(shape(menu({ group, hasTabHere: true, side: 'leftPane' })).slice(0, 2)).toEqual([
      'Move 2 conversations to left pane',
      'Move 2 conversations to new window'
    ])
  })

  it('offers each command in the direction that changes something, counting only that', () => {
    const labels = shape(
      rows(
        target('a', { pinned: true, hidden: 'self', live: true, unread: true }),
        target('b', { pinned: true, hidden: 'self', live: true, unread: true }),
        target('c', { pinned: true, hidden: 'folder' })
      )
    )
    expect(labels).toContain('Unpin 3')
    expect(labels).toContain('Unhide 2')
    expect(labels).toContain('Mark 2 as read')
    expect(labels).toContain('Stop 2 sessions!')
  })

  it('offers only one direction of each, even when the group is mixed', () => {
    const labels = shape(
      rows(
        target('a', { pinned: true, hidden: 'self', live: true, unread: true }),
        target('b', { live: true })
      )
    )
    expect(labels.slice(3)).toEqual(['Pin 1', 'Hide 1', 'Mark 1 as unread', '—', 'Stop 2 sessions!'])
  })

  it('drops hide altogether when only folders hide them, and read when none is running', () => {
    expect(shape(rows(target('a', { hidden: 'folder' }), target('b', { hidden: 'folder' })))).toEqual([
      'Open 2 conversations to the right',
      'Open 2 conversations in new window',
      '—',
      'Pin 2'
    ])
  })

  it('says nothing about where when none of them can be placed', () => {
    const unlinked = { linked: false, movable: false, live: true }
    expect(shape(rows(target('a', unlinked), target('b', unlinked)))).toEqual(['Stop 2 sessions!'])
  })

  it('counts one in the singular', () => {
    const labels = shape(rows(target('a', { live: true }), target('b', { linked: false, movable: false, live: true })))
    expect(labels.slice(0, 2)).toEqual(['Open 1 conversation to the right', 'Open 1 conversation in new window'])
    expect(labels).toContain('Stop 2 sessions!')
    expect(shape(rows(target('a', { live: true }), target('b')))).toContain('Stop 1 session!')
  })

  it('names each command for what it does — set, never toggle', () => {
    const actions = menu({
      group: menuGroup([target('a', { live: true, pinned: true, hidden: 'self', unread: true }), target('b', { pinned: true, hidden: 'self' })])
    }).flatMap((e) => ('separator' in e ? [] : [e.action]))
    expect(actions).toEqual(['toSide', 'newWindow', 'unpin', 'unhide', 'markRead', 'stop'])
  })
})

describe('the folder menu', () => {
  it('offers the one toggle in the direction it would go', () => {
    expect(folderMenu(false)).toEqual([{ action: 'hideFolder', label: 'Hide folder' }])
    expect(folderMenu(true)).toEqual([{ action: 'unhideFolder', label: 'Unhide folder' }])
  })
})
