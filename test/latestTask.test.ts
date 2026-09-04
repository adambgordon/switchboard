import { describe, expect, it } from 'vitest'
import { LatestTask } from '../src/main/latestTask'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('LatestTask', () => {
  it('shares the initial load and serves its settled value immediately', async () => {
    const first = deferred<number>()
    let loads = 0
    const task = new LatestTask(async () => {
      loads += 1
      return first.promise
    })

    const a = task.get()
    const b = task.get()
    expect(b).toBe(a)
    expect(loads).toBe(1)
    first.resolve(7)
    await expect(a).resolves.toBe(7)
    await expect(task.get()).resolves.toBe(7)
    expect(loads).toBe(1)
  })

  it('runs one trailing refresh when several changes arrive during a load', async () => {
    const gates = [deferred<number>(), deferred<number>()]
    let loads = 0
    const accepted: number[] = []
    const task = new LatestTask(
      () => gates[loads++].promise,
      (value) => accepted.push(value)
    )

    const running = task.refresh()
    expect(task.refresh()).toBe(running)
    expect(task.refresh()).toBe(running)
    gates[0].resolve(1)
    await Promise.resolve()
    expect(loads).toBe(2)
    gates[1].resolve(2)
    await expect(running).resolves.toBe(2)
    expect(accepted).toEqual([1, 2])
  })

  // The trailing pass must be bounded, not merely "one per quiet run". A change arriving during
  // the TRAILING pass used to queue another, so a steady stream of writes kept the loop going and
  // every caller waiting on `get()` waited for the whole chain. This refreshes on every pass, so
  // an unbounded implementation never stops; a bounded one stops at two.
  it('stops after one trailing pass even while changes keep arriving', async () => {
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()]
    let loads = 0
    const task = new LatestTask(() => {
      const gate = gates[loads]
      loads += 1
      // Request another refresh while THIS pass is in flight, every time.
      queueMicrotask(() => void task.refresh())
      return gate?.promise ?? Promise.resolve(-1)
    })

    const running = task.refresh()
    gates[0].resolve(1)
    await Promise.resolve()
    await Promise.resolve()
    gates[1].resolve(2)
    await expect(running).resolves.toBe(2)
    expect(loads).toBe(2)
  })

  it('does not queue a second load for concurrent readers', async () => {
    const gate = deferred<number>()
    let loads = 0
    const task = new LatestTask(async () => {
      loads += 1
      return gate.promise
    })
    const refresh = task.refresh()
    expect(task.get()).toBe(refresh)
    gate.resolve(3)
    await refresh
    expect(loads).toBe(1)
  })

  it('retries after a rejected load', async () => {
    let loads = 0
    const task = new LatestTask(async () => {
      loads += 1
      if (loads === 1) throw new Error('nope')
      return 4
    })
    await expect(task.get()).rejects.toThrow('nope')
    await expect(task.get()).resolves.toBe(4)
  })
})
