import { describe, expect, it } from 'vitest'
import {
  BoundTabReservations,
  retireInitialTabClaim,
  canReserveTabForBoundPty,
  claimWindowTabs,
  reconcileWindowTabs,
  shouldReleaseTab
} from '../src/main/tabOwnership'

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

  // A release queued for a window that has since become the tab's ONLY holder must be dropped.
  // The owner entry disappears when the claiming window closes (`releaseWindow` forgets its tabs),
  // so the queued release arrives with the session unowned. Answering "release" there closes the
  // last tab for a conversation that is still open — it vanishes from every window.
  it('drops a queued release once no other window owns the tab', () => {
    const owners = new Map([['TARGET', 2]])
    expect(shouldReleaseTab(owners, 1, 'TARGET')).toBe(true)
    owners.delete('TARGET')
    expect(shouldReleaseTab(owners, 1, 'TARGET')).toBe(false)
  })

  // Starting from an EMPTY map cannot catch a missing dedup: setting the same id twice lands on the
  // identical final state, so a raw-array loop and a de-duplicated one agree. Pre-owning the id
  // elsewhere is what separates them — an undeduplicated loop emits the release twice.
  it('deduplicates repeated ids in a malformed renderer report', () => {
    const owners = new Map([['A', 2]])
    expect(reconcileWindowTabs(owners, 1, ['A', 'A'])).toEqual([{ sessionId: 'A', ownerId: 1 }])
    expect([...owners]).toEqual([['A', 2]])
  })

  it('protects an eager claim from stale omissions until the target confirms it', () => {
    const owners = new Map([['S', 1]])
    const pending = new Map<string, number>()
    expect(claimWindowTabs(owners, 2, ['S'], pending)).toEqual([
      { sessionId: 'S', ownerId: 1 }
    ])
    expect([...pending]).toEqual([['S', 2]])

    // A report generated before the target received the placement must not erase the claim.
    expect(reconcileWindowTabs(owners, 2, [], pending)).toEqual([])
    expect(owners.get('S')).toBe(2)
    expect(shouldReleaseTab(owners, 1, 'S')).toBe(true)

    reconcileWindowTabs(owners, 2, ['S'], pending)
    expect(pending.has('S')).toBe(false)
    // Once confirmed, an ordinary later omission releases it normally.
    reconcileWindowTabs(owners, 2, [], pending)
    expect(owners.has('S')).toBe(false)
  })
})

describe('PTY bind tab ownership', () => {
  it('retires an initial placeholder without displacing the real-id owner before adoption', () => {
    const owners = new Map([
      ['PH', 1],
      ['S1', 2]
    ])
    expect(retireInitialTabClaim(owners, 'initial', 'PH', 'S1')).toBe(1)
    expect([...owners]).toEqual([['S1', 2]])
  })

  it('does not leave a phantom claim when closure reaches main after the initial bind', () => {
    const owners = new Map([['PH', 1]])
    const pending = new Map([['PH', 1]])
    expect(retireInitialTabClaim(owners, 'initial', 'PH', 'S1', pending)).toBe(1)
    expect([...pending]).toEqual([])

    reconcileWindowTabs(owners, 1, [], pending)
    expect([...owners]).toEqual([])
  })

  it('does not invent a tab claim from an initial bind after its placeholder tab closed', () => {
    const owners = new Map([['S1', 2]])
    expect(retireInitialTabClaim(owners, 'initial', 'PH', 'S2')).toBeNull()
    expect([...owners]).toEqual([['S1', 2]])
  })

  it('leaves correction ownership unchanged until the owning renderer moves a tab', () => {
    const owners = new Map([
      ['S1', 1],
      ['S2', 2]
    ])
    expect(retireInitialTabClaim(owners, 'correction', 'S1', 'S2')).toBeNull()
    expect([...owners]).toEqual([
      ['S1', 1],
      ['S2', 2]
    ])
  })

  it('reserves a bound-tab claim only for the owner of that PTY and identity', () => {
    const ptyOwners = new Map([['P1', 1]])
    const ptys = [{ ptyId: 'P1', sessionId: 'S2', fromSessionId: null }]

    expect(canReserveTabForBoundPty(ptyOwners, ptys, 2, 'P1', 'S2')).toBe(false)
    expect(canReserveTabForBoundPty(ptyOwners, ptys, 1, 'P1', 'wrong')).toBe(false)
    expect(canReserveTabForBoundPty(ptyOwners, ptys, 1, 'P1', 'S2')).toBe(true)
  })

  it('ignores a same-id bind without retiring its tab or pending claim', () => {
    const owners = new Map([['S1', 1]])
    const pending = new Map([['S1', 1]])
    expect(retireInitialTabClaim(owners, 'initial', 'S1', 'S1', pending)).toBeNull()
    expect([...owners]).toEqual([['S1', 1]])
    expect([...pending]).toEqual([['S1', 1]])
  })

  it('claims an adopted tab once, protecting it until the confirming report', () => {
    const owners = new Map([['PH', 1], ['S1', 2]])
    const pending = new Map<string, number>()
    const reservations = new BoundTabReservations()
    const windowId = retireInitialTabClaim(owners, 'initial', 'PH', 'S1', pending)!
    reservations.reserve('token', { windowId, ptyId: 'pty', sessionId: 'S1', fromSessionId: null })
    expect(reconcileWindowTabs(owners, 1, [], pending)).toEqual([])
    expect(owners.get('S1')).toBe(2)

    expect(reservations.take('token', 2)).toBeNull()
    const adopted = reservations.take('token', 1)!
    expect(claimWindowTabs(owners, adopted.windowId, [adopted.sessionId], pending)).toEqual([
      { sessionId: 'S1', ownerId: 2 }
    ])
    expect(reservations.take('token', 1)).toBeNull()
    reconcileWindowTabs(owners, 1, [], pending)
    expect(owners.get('S1')).toBe(1)
    reconcileWindowTabs(owners, 1, ['S1'], pending)
    expect([...pending]).toEqual([])
    reconcileWindowTabs(owners, 1, [], pending)
    expect([...owners]).toEqual([])
  })

  it('keeps concurrent adoptions independent and invalidates superseded tokens', () => {
    const reservations = new BoundTabReservations()
    reservations.reserve('old', { windowId: 1, ptyId: 'a', sessionId: 'S1', fromSessionId: null })
    reservations.reserve('other', { windowId: 2, ptyId: 'b', sessionId: 'S2', fromSessionId: null })
    reservations.reserve('new', { windowId: 1, ptyId: 'a', sessionId: 'S3', fromSessionId: null })
    expect(reservations.take('old', 1)).toBeNull()
    expect(reservations.take('new', 1)).toEqual({ windowId: 1, ptyId: 'a', sessionId: 'S3', fromSessionId: null })
    expect(reservations.take('other', 2)).toEqual({ windowId: 2, ptyId: 'b', sessionId: 'S2', fromSessionId: null })
  })

  it('discards exited PTYs and closed windows without affecting other reservations', () => {
    const reservations = new BoundTabReservations()
    reservations.reserve('exit', { windowId: 1, ptyId: 'a', sessionId: 'S1', fromSessionId: null })
    reservations.reserve('close', { windowId: 1, ptyId: 'b', sessionId: 'S2', fromSessionId: null })
    reservations.reserve('survive', { windowId: 2, ptyId: 'c', sessionId: 'S3', fromSessionId: null })
    reservations.discardPty('a')
    expect(reservations.take('exit', 1)).toBeNull()
    reservations.discardWindow(1)
    expect(reservations.take('close', 1)).toBeNull()
    expect(reservations.take('survive', 2)).toEqual({ windowId: 2, ptyId: 'c', sessionId: 'S3', fromSessionId: null })
  })
})
