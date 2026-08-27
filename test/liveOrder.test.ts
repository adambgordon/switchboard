import { describe, expect, it } from 'vitest'
import { retargetOrder } from '../src/renderer/lib/useLiveOrder'

/**
 * Live rows are keyed by sessionId, and a live Codex terminal's sessionId can change under it. The
 * order sync reads that as "the old row died, a new one appeared" and prepends — treating the SAME
 * terminal as newly live. `retargetOrder` is what keeps the row in place instead.
 */
describe('retargetOrder', () => {
  it('replaces the id in place, keeping the row in its slot', () => {
    // The case the sync gets wrong: a row in the MIDDLE. Prepending would give [S2, B, A].
    expect(retargetOrder(['B', 'S1', 'A'], 'S1', 'S2')).toEqual(['B', 'S2', 'A'])
  })

  it('keeps a bottom row at the bottom', () => {
    expect(retargetOrder(['B', 'A', 'S1'], 'S1', 'S2')).toEqual(['B', 'A', 'S2'])
  })

  it('is a no-op when the old id is not live', () => {
    const order = ['B', 'A']
    expect(retargetOrder(order, 'S1', 'S2')).toBe(order)
  })

  it('is a no-op when the ids match', () => {
    const order = ['B', 'S1', 'A']
    expect(retargetOrder(order, 'S1', 'S1')).toBe(order)
  })

  it('drops a stale entry for the incoming id and keeps the corrected row in its own slot', () => {
    // Reachable: a PTY owning S2 exits, and before the sync prunes its row another PTY is corrected
    // onto the now-unowned S2. A present S2 can only be stale — `bindCodex` refuses a conversation a
    // LIVE PTY owns — so the dead row goes and the corrected row is retargeted where it stands.
    // Refusing instead would hand the corrected PTY the dead row's position.
    expect(retargetOrder(['S2', 'S1', 'A'], 'S1', 'S2')).toEqual(['S2', 'A'])
    expect(retargetOrder(['B', 'S1', 'S2'], 'S1', 'S2')).toEqual(['B', 'S2'])
  })

  it('never yields a duplicate key', () => {
    for (const order of [
      ['S2', 'S1'],
      ['S1', 'S2'],
      ['A', 'S2', 'B', 'S1', 'C']
    ]) {
      const out = retargetOrder(order, 'S1', 'S2')
      expect(new Set(out).size).toBe(out.length)
    }
  })

  it('returns the same reference when nothing changes, so identity stays stable', () => {
    const order = ['B', 'A']
    expect(retargetOrder(order, 'nope', 'other')).toBe(order)
  })
})
