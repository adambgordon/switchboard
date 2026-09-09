import { describe, expect, it, vi } from 'vitest'
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

  // The original caller must stop after one trailing pass, but the watcher event that arrived during
  // that pass is still a real request. It starts a detached chain after the caller is released.
  it('releases the caller after two passes and accepts a dirty trailing pass afterward', async () => {
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()]
    let loads = 0
    const accepted: number[] = []
    const task = new LatestTask(
      () => {
        const gate = gates[loads]
        loads += 1
        if (loads <= 2) queueMicrotask(() => void task.refresh())
        return gate?.promise ?? Promise.resolve(-1)
      },
      (value) => accepted.push(value)
    )

    const running = task.refresh()
    gates[0].resolve(1)
    await Promise.resolve()
    await Promise.resolve()
    gates[1].resolve(2)
    await expect(running).resolves.toBe(2)
    await vi.waitFor(() => expect(loads).toBe(3))
    expect(accepted).toEqual([1, 2])
    gates[2].resolve(3)
    await vi.waitFor(() => expect(task.peek()).toBe(3))
    expect(accepted).toEqual([1, 2, 3])
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
