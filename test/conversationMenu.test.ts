import { describe, expect, it } from 'vitest'
import { conversationMenu, folderMenu, type ConversationMenuState } from '../src/renderer/lib/conversationMenu'
import type { ConversationMenuEntry } from '../src/shared/types'

/**
 * The conversation menu is ONE list for the rail row and the tab. These pin its order, its words, and
 * that the two surfaces differ only by the tab's own Close group.
 */

const base: ConversationMenuState = {
  surface: 'row',
  count: 1,
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

  it('a selection of several keeps only what applies to all of them, and counts them', () => {
    expect(shape(menu({ surface: 'tab', count: 3, live: true, closeOthers: true }))).toEqual([
      'Move 3 tabs to the right',
      'Move 3 tabs to new window',
      '—',
      'Close 3 tabs',
      'Close other tabs'
    ])
  })

  it('…whether they are running or not: a selection of finished ones offers no Resume either', () => {
    expect(shape(menu({ surface: 'tab', count: 2, live: false, closeOthers: false }))).toEqual([
      'Move 2 tabs to the right',
      'Move 2 tabs to new window',
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
    expect(shape(menu({ surface: 'tab', count: 2, closeOthers: true, reopen: 3 }))).toEqual([
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

describe('the folder menu', () => {
  it('offers the one toggle in the direction it would go', () => {
    expect(folderMenu(false)).toEqual([{ action: 'hideFolder', label: 'Hide folder' }])
    expect(folderMenu(true)).toEqual([{ action: 'unhideFolder', label: 'Unhide folder' }])
  })
})
