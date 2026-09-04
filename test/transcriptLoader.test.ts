import { describe, expect, it } from 'vitest'
import type { Transcript } from '../src/shared/types'
import { TranscriptLoader, type TranscriptSource } from '../src/main/transcriptLoader'

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

  // A session's file can move while the app runs — Claude derives its project directory from the
  // cwd, so renaming that directory re-encodes the path. Caching the resolved path forever meant
  // every later parse threw against the stale path and the transcript stayed blank until restart.
  // Asserting the recovered PATH rather than a resolve count is what pins this: a loader that
  // merely re-resolved by luck would still hand the old path to `parseSource`.
  it('re-resolves the path after a parse failure so a moved file recovers', async () => {
    const paths = ['/old/session.jsonl', '/new/session.jsonl']
    const attempted: string[] = []
    const loader = new TranscriptLoader(
      async () => ({ agent: 'claude', path: paths[Math.min(attempted.length, 1)] }),
      async (source: TranscriptSource) => {
        attempted.push(source.path)
        if (source.path === '/old/session.jsonl') throw new Error('ENOENT')
        return transcript('moved')
      }
    )

    await expect(loader.load('session', '1:10')).resolves.toBeNull()
    await expect(loader.load('session', '2:20')).resolves.toEqual(transcript('moved'))
    expect(attempted).toEqual(['/old/session.jsonl', '/new/session.jsonl'])
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
