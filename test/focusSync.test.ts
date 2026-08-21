import { describe, expect, it } from 'vitest'
import { startFocusSync } from '../src/renderer/lib/focusSync'

/**
 * Drives startFocusSync with the seed held open, so the window between "subscribed" and "seed
 * resolved" — the window the real defect lived in — is directly reachable.
 */
function harness() {
  const order: string[] = []
  const applied: boolean[] = []
  let push: ((focused: boolean) => void) | null = null
  let settle: ((focused: boolean) => void) | null = null
  let fail: ((err: unknown) => void) | null = null
  let unsubscribes = 0

  const stop = startFocusSync({
    subscribe: (cb) => {
      order.push('subscribe')
      push = cb
      return () => {
        unsubscribes++
      }
    },
    querySeed: () => {
      order.push('querySeed')
      return new Promise<boolean>((res, rej) => {
        settle = res
        fail = rej
      })
    },
    apply: (focused) => {
      applied.push(focused)
    }
  })

  return {
    order,
    applied,
    stop,
    push: (focused: boolean) => push?.(focused),
    resolveSeed: (focused: boolean) => settle?.(focused),
    rejectSeed: () => fail?.(new Error('no owner')),
    unsubscribes: () => unsubscribes,
    // Let the seed's .then/.catch run.
    flush: () => new Promise((r) => setTimeout(r, 0))
  }
}

describe('startFocusSync', () => {
  // Rule 1. If the seed were requested first, a transition arriving during the round-trip would
  // have no listener and be dropped — leaving the flag on a value already known to be stale.
  it('subscribes before requesting the seed', () => {
    const h = harness()
    expect(h.order).toEqual(['subscribe', 'querySeed'])
  })

  it('applies the seed when no transition arrived', async () => {
    const h = harness()
    h.resolveSeed(true)
    await h.flush()
    expect(h.applied).toEqual([true])
  })

  // Rule 2. The push happened after the seed was requested, so it is the newer fact; applying the
  // seed afterward would walk the flag back to the pre-transition value.
  it('lets a push during the seed round-trip win over the seed', async () => {
    const h = harness()
    h.push(true)
    h.resolveSeed(false)
    await h.flush()
    expect(h.applied).toEqual([true])
  })

  it('applies every push, in order', async () => {
    const h = harness()
    h.push(true)
    h.push(false)
    h.push(true)
    h.resolveSeed(false)
    await h.flush()
    expect(h.applied).toEqual([true, false, true])
  })

  it('applies pushes that arrive after the seed', async () => {
    const h = harness()
    h.resolveSeed(true)
    await h.flush()
    h.push(false)
    expect(h.applied).toEqual([true, false])
  })

  it('applies nothing from a push after teardown', () => {
    const h = harness()
    h.stop()
    h.push(true)
    expect(h.applied).toEqual([])
  })

  it('applies nothing from a seed that resolves after teardown', async () => {
    const h = harness()
    h.stop()
    h.resolveSeed(true)
    await h.flush()
    expect(h.applied).toEqual([])
  })

  it('unsubscribes on teardown', () => {
    const h = harness()
    expect(h.unsubscribes()).toBe(0)
    h.stop()
    expect(h.unsubscribes()).toBe(1)
  })

  // A failed seed must not become an unhandled rejection; the flag simply waits for the next push.
  it('survives a failed seed and still applies later pushes', async () => {
    const h = harness()
    h.rejectSeed()
    await h.flush()
    expect(h.applied).toEqual([])
    h.push(true)
    expect(h.applied).toEqual([true])
  })
})
