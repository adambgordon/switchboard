import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { ConversationMeta } from '../src/shared/types'
import { SessionWorkerClient, type WorkerLike } from '../src/main/sessions/sessionWorkerClient'
import type { SessionWorkerReply, SessionWorkerRequest } from '../src/main/sessions/sessionWorkerProtocol'

/** A stand-in worker that records what it was sent and replies only when told to. */
class FakeWorker extends EventEmitter implements WorkerLike {
  posted: SessionWorkerRequest[] = []
  terminated = false
  postMessage(request: SessionWorkerRequest): void {
    this.posted.push(request)
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
  reply(path: string, title: string): void {
    const request = this.posted.find((r) => r.job.path === path)!
    const reply: SessionWorkerReply = { id: request.id, result: { title } as ConversationMeta }
    this.emit('message', reply)
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(limit = 2) {
  const worker = new FakeWorker()
  const inProcessCalls: string[] = []
  const client = new SessionWorkerClient(
    () => worker,
    async (_agent, path) => {
      inProcessCalls.push(path)
      return { title: `in-process:${path}` } as ConversationMeta
    },
    limit
  )
  return { worker, client, inProcessCalls }
}

describe('SessionWorkerClient', () => {
  it('sends a job to the worker and resolves with its reply', async () => {
    const { worker, client, inProcessCalls } = setup()
    const meta = client.meta('claude', '/a.jsonl', 'foreground')
    expect(worker.posted.map((r) => r.job)).toEqual([{ kind: 'meta', agent: 'claude', path: '/a.jsonl' }])
    worker.reply('/a.jsonl', 'from worker')
    await expect(meta).resolves.toEqual({ title: 'from worker' })
    expect(client.served()).toBe(1)
    expect(inProcessCalls).toEqual([])
  })

  it('matches replies to jobs by id, whatever order they arrive in', async () => {
    const { worker, client } = setup()
    const a = client.meta('codex', '/a.jsonl', 'background')
    const b = client.meta('codex', '/b.jsonl', 'background')
    worker.reply('/b.jsonl', 'B')
    worker.reply('/a.jsonl', 'A')
    await expect(a).resolves.toEqual({ title: 'A' })
    await expect(b).resolves.toEqual({ title: 'B' })
  })

  it('holds only `limit` jobs in the worker, and a foreground job jumps the background backlog', async () => {
    const { worker, client } = setup(1)
    void client.meta('codex', '/bg1.jsonl', 'background')
    void client.meta('codex', '/bg2.jsonl', 'background')
    void client.meta('codex', '/bg3.jsonl', 'background')
    void client.meta('claude', '/fg.jsonl', 'foreground')
    expect(worker.posted.map((r) => r.job.path)).toEqual(['/bg1.jsonl'])
    expect(client.backlog()).toBe(2)
    worker.reply('/bg1.jsonl', 'x')
    await tick()
    expect(worker.posted.map((r) => r.job.path)).toEqual(['/bg1.jsonl', '/fg.jsonl'])
  })

  for (const event of ['error', 'exit'] as const) {
    it(`on worker ${event}, answers held and later jobs in-process`, async () => {
      const { worker, client, inProcessCalls } = setup()
      const held = client.meta('claude', '/held.jsonl', 'foreground')
      worker.emit(event)
      await expect(held).resolves.toEqual({ title: 'in-process:/held.jsonl' })
      await expect(client.meta('claude', '/later.jsonl', 'foreground')).resolves.toEqual({
        title: 'in-process:/later.jsonl'
      })
      expect(inProcessCalls).toEqual(['/held.jsonl', '/later.jsonl'])
      expect(client.alive()).toBe(false)
      expect(worker.terminated).toBe(true)
      expect(worker.posted.map((r) => r.job.path)).toEqual(['/held.jsonl'])
    })
  }

  it('ignores a late reply for a job already answered in-process', async () => {
    const { worker, client } = setup()
    const held = client.meta('claude', '/held.jsonl', 'foreground')
    worker.emit('error')
    await expect(held).resolves.toEqual({ title: 'in-process:/held.jsonl' })
    worker.reply('/held.jsonl', 'too late')
    expect(client.served()).toBe(0)
  })

  it('parses in-process from the start when the worker cannot be created', async () => {
    const client = new SessionWorkerClient(
      () => {
        throw new Error('no worker bundle')
      },
      async (_agent, path) => ({ title: `in-process:${path}` }) as ConversationMeta
    )
    expect(client.alive()).toBe(false)
    await expect(client.meta('codex', '/a.jsonl', 'foreground')).resolves.toEqual({ title: 'in-process:/a.jsonl' })
  })

  it('answers null when the in-process parser fails', async () => {
    const client = new SessionWorkerClient(
      () => {
        throw new Error('no worker')
      },
      () => Promise.reject(new Error('parse failed'))
    )
    await expect(client.meta('claude', '/a.jsonl', 'foreground')).resolves.toBeNull()
  })
})
