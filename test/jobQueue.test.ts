import { describe, expect, it } from 'vitest'
import { JobQueue } from '../src/main/sessions/jobQueue'

/** A start function whose jobs finish only when the test says so. */
function controlled() {
  const started: string[] = []
  const finishers = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>()
  const start = (job: string) =>
    new Promise<string>((resolve, reject) => {
      started.push(job)
      finishers.set(job, { resolve, reject })
    })
  const finish = async (job: string) => {
    finishers.get(job)!.resolve(`done:${job}`)
    await new Promise((r) => setTimeout(r, 0))
  }
  const fail = async (job: string) => {
    finishers.get(job)!.reject(new Error(job))
    await new Promise((r) => setTimeout(r, 0))
  }
  return { started, start, finish, fail }
}

describe('JobQueue', () => {
  it('never hands out more than the limit at once', async () => {
    const c = controlled()
    const q = new JobQueue(2, c.start)
    for (const j of ['a', 'b', 'c', 'd']) void q.run(j, 'background')
    expect(c.started).toEqual(['a', 'b'])
    expect(q.counts()).toEqual({ foreground: 0, background: 2, running: 2 })
    await c.finish('a')
    expect(c.started).toEqual(['a', 'b', 'c'])
  })

  it('starts a foreground job ahead of background jobs queued before it', async () => {
    const c = controlled()
    const q = new JobQueue(1, c.start)
    void q.run('blocker', 'background')
    void q.run('bg1', 'background')
    void q.run('bg2', 'background')
    void q.run('fg', 'foreground')
    await c.finish('blocker')
    await c.finish('fg')
    await c.finish('bg1')
    // Priority first, then queue order within a priority — not arrival order, not reversed.
    expect(c.started).toEqual(['blocker', 'fg', 'bg1', 'bg2'])
  })

  it('resolves each caller with its own job result', async () => {
    const c = controlled()
    const q = new JobQueue(2, c.start)
    const a = q.run('a', 'background')
    const b = q.run('b', 'foreground')
    await c.finish('b')
    await c.finish('a')
    await expect(a).resolves.toBe('done:a')
    await expect(b).resolves.toBe('done:b')
  })

  it('passes a failure to its caller and still frees the slot', async () => {
    const c = controlled()
    const q = new JobQueue(1, c.start)
    const a = expect(q.run('a', 'background')).rejects.toThrow('a')
    void q.run('b', 'background')
    await c.fail('a')
    await a
    expect(c.started).toEqual(['a', 'b'])
  })

  it('treats a start function that throws synchronously as a failed job', async () => {
    let calls = 0
    const q = new JobQueue<string, string>(1, (job) => {
      calls++
      if (job === 'bad') throw new Error('sync')
      return Promise.resolve(job)
    })
    await expect(q.run('bad', 'foreground')).rejects.toThrow('sync')
    await expect(q.run('good', 'foreground')).resolves.toBe('good')
    expect(calls).toBe(2)
  })
})
