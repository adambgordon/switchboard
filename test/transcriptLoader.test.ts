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
    expect(resolves).toBe(2)
  })
})
