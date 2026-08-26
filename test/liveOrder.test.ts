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

  it('refuses to introduce a duplicate row', () => {
    // Contradictory input — two live PTYs cannot own one conversation, and `bindCodex` refuses it.
    // Rewriting anyway would put the same key in the list twice, which is worse than not moving.
    const order = ['S2', 'S1', 'A']
    expect(retargetOrder(order, 'S1', 'S2')).toBe(order)
  })

  it('returns the same reference when nothing changes, so identity stays stable', () => {
    const order = ['B', 'A']
    expect(retargetOrder(order, 'nope', 'other')).toBe(order)
  })
})
