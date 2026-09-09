import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Transcript } from '../src/shared/types'
import { TranscriptLoader, type TranscriptSource } from '../src/main/transcriptLoader'
import { parseTranscript } from '../src/main/sessions/parser'
import { parseCodexTranscript } from '../src/main/sessions/codexParser'

const transcript = (text: string): Transcript => ({
  sessionId: 'session',
  agent: 'claude',
  cwd: '/repo',
  title: 'Title',
  messages: [{
    uuid: text,
    role: 'assistant',
    blocks: [{ kind: 'text', text }],
    timestamp: null,
    isSidechain: false
  }]
})

describe('TranscriptLoader', () => {
  it('shares an in-flight parse for one revision', async () => {
    let finish = (_value: Transcript | null): void => {}
    let parses = 0
    const loader = new TranscriptLoader(
      async () => ({ agent: 'claude', path: '/session.jsonl' }),
      () => {
        parses += 1
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    )
    const first = loader.load('session', '1:10')
    const second = loader.load('session', '1:10')
    expect(second).toBe(first)
    await Promise.resolve()
    expect(parses).toBe(1)
    finish(transcript('done'))
    await expect(first).resolves.toEqual(transcript('done'))
  })

  it('starts a new parse for a new revision while reusing the resolved path', async () => {
    let resolves = 0
    const parsed: string[] = []
    const loader = new TranscriptLoader(
      async () => {
        resolves += 1
        return { agent: 'codex', path: '/rollout.jsonl' }
      },
      async (source: TranscriptSource) => {
        parsed.push(source.path)
        return transcript(String(parsed.length))
      }
    )
    await loader.load('session', '1:10')
    await loader.load('session', '2:20')
    expect(resolves).toBe(1)
    expect(parsed).toEqual(['/rollout.jsonl', '/rollout.jsonl'])
  })

  it('does not retain a missing source or rejected parse', async () => {
    let resolves = 0
    let fail = true
    const loader = new TranscriptLoader(
      async () => {
        resolves += 1
        return resolves === 1 ? null : { agent: 'claude', path: '/session.jsonl' }
      },
      async () => {
        if (fail) throw new Error('partial write')
        return transcript('recovered')
      }
    )
    await expect(loader.load('session', '1:0')).resolves.toBeNull()
    await expect(loader.load('session', '2:10')).resolves.toBeNull()
    fail = false
    await expect(loader.load('session', '3:20')).resolves.toEqual(transcript('recovered'))
  })

  it.each(['claude', 'codex'] as const)('recovers a moved %s file in the same request using the real parser', async (agent) => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-loader-'))
    try {
      await mkdir(join(dir, 'old'))
      await mkdir(join(dir, 'new'))
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const file = agent === 'claude' ? `${id}.jsonl` : `rollout-2026-09-09T00-00-00-${id}.jsonl`
      const before = join(dir, 'old', file)
      const after = join(dir, 'new', file)
      const record = agent === 'claude'
        ? { type: 'user', uuid: 'one', cwd: '/repo', message: { role: 'user', content: 'Hello' } }
        : { type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } }
      await writeFile(before, JSON.stringify(record) + '\n')
      const parse = agent === 'claude' ? parseTranscript : parseCodexTranscript
      let currentPath = before
      let resolves = 0
      const loader = new TranscriptLoader(async () => {
        resolves += 1
        return { agent, path: currentPath }
      }, (source) => parse(source.path))
      expect((await loader.load(id, '1'))?.messages).toHaveLength(1)
      await rename(before, after)
      currentPath = after
      const recovered = await loader.load(id, '2')
      expect(recovered?.messages[0]?.blocks).toEqual([{ kind: 'text', text: 'Hello' }])
      expect((await loader.load(id, '3'))?.messages).toHaveLength(1)
      expect(resolves).toBe(2)

      await rm(after)
      await expect(loader.load(id, '4')).resolves.toBeNull()
      await writeFile(after, JSON.stringify(record) + '\n')
      expect((await loader.load(id, '5'))?.messages).toHaveLength(1)
      expect(resolves).toBe(4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('bounds recovery to one retry and leaves failed paths uncached', async () => {
    let fail = false
    const attempted: string[] = []
    let resolves = 0
    const loader = new TranscriptLoader(async () => ({
      agent: 'claude', path: `/path-${++resolves}.jsonl`
    }), async (source) => {
      attempted.push(source.path)
      if (fail) throw new Error('unreadable')
      return transcript('available')
    })
    await loader.load('session', '1')
    fail = true
    await expect(loader.load('session', '2')).resolves.toBeNull()
    expect(attempted).toEqual(['/path-1.jsonl', '/path-1.jsonl', '/path-2.jsonl'])
    fail = false
    await expect(loader.load('session', '3')).resolves.toEqual(transcript('available'))
    expect(resolves).toBe(3)
  })

  it('does not evict a newer resolved path when an older cold parse fails late', async () => {
    let rejectOld: (error: Error) => void = () => {}
    let resolves = 0
    let parses = 0
    const loader = new TranscriptLoader(async () => ({
      agent: 'claude', path: ++resolves === 1 ? '/old.jsonl' : '/new.jsonl'
    }), async (source) => {
      parses += 1
      if (parses === 1) return new Promise((_resolve, reject) => { rejectOld = reject })
      if (source.path === '/old.jsonl') throw new Error('moved')
      return transcript('new')
    })
    const older = loader.load('session', '1')
    await Promise.resolve()
    await expect(loader.load('session', '2')).resolves.toEqual(transcript('new'))
    rejectOld(new Error('moved'))
    await expect(older).resolves.toBeNull()
    await expect(loader.load('session', '3')).resolves.toEqual(transcript('new'))
    expect(resolves).toBe(2)
  })

  // Sequential loads at different revisions cannot catch a key that ignores the revision, because
  // each settles and is deleted before the next starts — both a keyed and an unkeyed loader parse
  // twice. Only CONCURRENT loads at different revisions distinguish them: an unkeyed loader would
  // hand the second caller the first revision's older parse.
  it('does not share a concurrent parse across two different revisions', async () => {
    const finishers: Array<(value: Transcript | null) => void> = []
    const loader = new TranscriptLoader(
      async () => ({ agent: 'claude', path: '/session.jsonl' }),
      () => new Promise((resolve) => finishers.push(resolve))
    )

    const older = loader.load('session', '1:10')
    const newer = loader.load('session', '2:20')
    expect(newer).not.toBe(older)
    await Promise.resolve()
    expect(finishers).toHaveLength(2)

    finishers[0](transcript('older'))
    finishers[1](transcript('newer'))
    await expect(older).resolves.toEqual(transcript('older'))
    await expect(newer).resolves.toEqual(transcript('newer'))
  })
})
