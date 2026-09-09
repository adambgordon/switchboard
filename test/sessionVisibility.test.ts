import { describe, expect, it } from 'vitest'
import type { ConversationMeta } from '../src/shared/types'
import { retainHiddenSessions, visibleTabDrag, visibleTabLayout } from '../src/shared/sessionVisibility'
import { paneReducer, restorePaneLayout, snapshotPaneLayout } from '../src/renderer/lib/paneModel'

const hidden = new Set(['H', 'J'])

describe('session visibility', () => {
  it('retains positive evidence across an empty scan without hiding an unknown id', () => {
    const empty = retainHiddenSessions({ groups: [], hiddenSessionIds: [] }, hidden)
    expect(empty.hiddenSessionIds).toEqual(['H', 'J'])
    const group = {
      cwd: '/project', label: 'project', latestMtime: 3,
      conversations: [
        { sessionId: 'H', mtime: 3 }, { sessionId: 'unknown', mtime: 2 }
      ] as ConversationMeta[]
    }
    const result = retainHiddenSessions({ groups: [group], hiddenSessionIds: ['NEW'] }, hidden)
    expect(result.hiddenSessionIds).toEqual(['H', 'J', 'NEW'])
    expect(result.groups[0].conversations.map((meta) => meta.sessionId)).toEqual(['unknown'])
    expect(result.groups[0].latestMtime).toBe(2)
    expect(group.conversations).toHaveLength(2)
    expect(retainHiddenSessions({ groups: [{ ...group, conversations: [group.conversations[0]] }], hiddenSessionIds: [] }, hidden).groups).toEqual([])
  })

  it('prunes saved panes using the same selected-neighbor rule as live bulk close', () => {
    const saved = { panes: [
      { sessionIds: ['A', 'H', 'C', 'D'], activeSessionId: 'H' },
      { sessionIds: ['J'], activeSessionId: 'J' }
    ] }
    const result = visibleTabLayout(saved, hidden)
    expect(result).toEqual({ panes: [{ sessionIds: ['A', 'C', 'D'], activeSessionId: 'C' }] })
    const live = paneReducer(restorePaneLayout(saved, ['p0', 'p1']), { type: 'closeMany', sessionIds: ['H', 'J'] })
    expect(snapshotPaneLayout(live)).toEqual(result)
    expect(visibleTabLayout(result, hidden)).toEqual(result)
  })

  it('preserves deliberate deselection and unknown tabs, and empties all-hidden layouts', () => {
    expect(visibleTabLayout({ panes: [{ sessionIds: ['unknown', 'H'], activeSessionId: null }] }, hidden)).toEqual({
      panes: [{ sessionIds: ['unknown'], activeSessionId: null }]
    })
    expect(visibleTabLayout({ panes: [{ sessionIds: ['H'], activeSessionId: 'H' }] }, hidden)).toBeNull()
    expect(visibleTabLayout(null, hidden)).toBeNull()
  })

  it('preserves surviving drag order and the grabbed tab, replacing it only if hidden', () => {
    expect(visibleTabDrag({ sessionIds: ['A', 'H', 'C'], activeSessionId: 'C' }, hidden)).toEqual({ sessionIds: ['A', 'C'], activeSessionId: 'C' })
    expect(visibleTabDrag({ sessionIds: ['A', 'H', 'C'], activeSessionId: 'H' }, hidden)).toEqual({ sessionIds: ['A', 'C'], activeSessionId: 'A' })
    expect(visibleTabDrag({ sessionIds: ['H', 'J'], activeSessionId: 'H' }, hidden)).toBeNull()
  })
})
