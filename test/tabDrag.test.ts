import { describe, expect, it } from 'vitest'
import { makeTabDragPayload, parseTabDragPayload } from '../src/shared/tabDrag'

describe('makeTabDragPayload', () => {
  it('carries a selection in source-strip order while preserving the grabbed tab', () => {
    expect(makeTabDragPayload(['A', 'B', 'C', 'D'], ['D', 'B'], 'D')).toEqual({
      sessionIds: ['B', 'D'],
      activeSessionId: 'D'
    })
  })

  it('always includes the grabbed tab', () => {
    expect(makeTabDragPayload(['A', 'B', 'C'], ['B'], 'C')).toEqual({
      sessionIds: ['B', 'C'],
      activeSessionId: 'C'
    })
  })
})

describe('parseTabDragPayload', () => {
  it('accepts a valid payload and removes duplicate ids in place', () => {
    expect(
      parseTabDragPayload({ sessionIds: ['B', 'A', 'B'], activeSessionId: 'A' })
    ).toEqual({ sessionIds: ['B', 'A'], activeSessionId: 'A' })
  })

  it('rejects malformed payloads and an active tab outside the group', () => {
    expect(parseTabDragPayload(null)).toBeNull()
    expect(parseTabDragPayload({ sessionIds: 'A', activeSessionId: 'A' })).toBeNull()
    expect(parseTabDragPayload({ sessionIds: ['A'], activeSessionId: 'B' })).toBeNull()
    expect(parseTabDragPayload({ sessionIds: ['A'], activeSessionId: '' })).toBeNull()
  })
})
