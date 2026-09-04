import { describe, expect, it } from 'vitest'
import { claimWindowTabs, reconcileWindowTabs, shouldReleaseTab } from '../src/main/tabOwnership'

describe('reconcileWindowTabs', () => {
  it('replaces one window’s stale claims with its complete current set', () => {
    const owners = new Map([
      ['A', 1],
      ['B', 1],
      ['C', 2]
    ])
    expect(reconcileWindowTabs(owners, 1, ['B', 'D'])).toEqual([])
    expect([...owners]).toEqual([
      ['B', 1],
      ['C', 2],
      ['D', 1]
    ])
  })

  it('rejects a colliding full-set report without changing the owner', () => {
    const owners = new Map([
      ['TARGET', 2],
      ['UNCHANGED', 2]
    ])
    expect(reconcileWindowTabs(owners, 1, ['TARGET'])).toEqual([
      { sessionId: 'TARGET', ownerId: 1 }
    ])
    expect([...owners]).toEqual([
      ['TARGET', 2],
      ['UNCHANGED', 2]
    ])
  })

  it('lets an explicit placement displace the prior owner', () => {
    const owners = new Map([
      ['TARGET', 2],
      ['UNCHANGED', 2]
    ])
    expect(claimWindowTabs(owners, 1, ['TARGET'])).toEqual([
      { sessionId: 'TARGET', ownerId: 2 }
    ])
    expect([...owners]).toEqual([
      ['TARGET', 1],
      ['UNCHANGED', 2]
    ])
  })

  it('invalidates a queued release after ownership changes back', () => {
    const owners = new Map([['TARGET', 2]])
    expect(shouldReleaseTab(owners, 1, 'TARGET')).toBe(true)
    claimWindowTabs(owners, 1, ['TARGET'])
    expect(shouldReleaseTab(owners, 1, 'TARGET')).toBe(false)
  })

  it('deduplicates repeated ids in a malformed renderer report', () => {
    const owners = new Map<string, number>()
    expect(reconcileWindowTabs(owners, 1, ['A', 'A'])).toEqual([])
    expect([...owners]).toEqual([['A', 1]])
  })
})
