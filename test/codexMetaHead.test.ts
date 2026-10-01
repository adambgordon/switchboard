import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractCodexMeta } from '../src/main/sessions/codexParser'

const ID = '00000000-0000-7000-8000-000000000001'
const TS = '2026-07-27T12:00:00.000Z'

function sessionMeta(payload: Record<string, unknown>): object {
  return {
    timestamp: TS,
    type: 'session_meta',
    payload: { id: ID, cwd: '/repo/one', originator: 'codex-tui', cli_version: '0.150.0', ...payload }
  }
}

/** A tail that, if read, makes the result unmistakably different: one counted human turn. */
const TAIL = [
  { timestamp: TS, type: 'turn_context', payload: { cwd: '/repo/one', model: 'gpt-x' } },
  { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'a real prompt' } }
]

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

let dir: string
let n = 0
async function rollout(text: string): Promise<string> {
  const file = path.join(dir, `rollout-2026-07-27T12-00-0${n++}-${ID}.jsonl`)
  await writeFile(file, text, 'utf8')
  return file
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'codex-meta-head-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('extractCodexMeta — subagent answered from the session_meta head', () => {
  it('does not read past the head of a subagent rollout', async () => {
    const meta = await extractCodexMeta(await rollout(jsonl([sessionMeta({ thread_source: 'subagent' }), ...TAIL])))
    expect(meta).toMatchObject({ codexSubagent: true, threadSource: 'subagent', cwd: '/repo/one', version: '0.150.0' })
    // The tail's prompt and model were never read.
    expect(meta?.messageCount).toBe(0)
    expect(meta?.model).toBeNull()
  })

  it('reads the marker from any line of a multi-line head, e.g. a fork', async () => {
    const meta = await extractCodexMeta(
      await rollout(jsonl([sessionMeta({}), sessionMeta({ source: { subagent: { other: 'x' } } }), ...TAIL]))
    )
    expect(meta?.codexSubagent).toBe(true)
    expect(meta?.messageCount).toBe(0)
  })

  it('reads the whole file when the head does not say subagent', async () => {
    const meta = await extractCodexMeta(await rollout(jsonl([sessionMeta({ thread_source: 'user' }), ...TAIL])))
    expect(meta).toMatchObject({ codexSubagent: false, messageCount: 1, model: 'gpt-x' })
  })

  it('still finds a marker that only appears after the head, by reading the whole file', async () => {
    const meta = await extractCodexMeta(
      await rollout(jsonl([sessionMeta({}), ...TAIL, sessionMeta({ thread_source: 'subagent' })]))
    )
    expect(meta).toMatchObject({ codexSubagent: true, messageCount: 1 })
  })

  it('decodes a multi-byte character that straddles a read-chunk boundary', async () => {
    // Pad ahead of the cwd so the 3-byte '€' in it starts one byte before the 64 KiB boundary.
    const cwd = '/repo/€uro'
    const lineWith = (pad: string): string =>
      JSON.stringify({
        timestamp: TS,
        type: 'session_meta',
        payload: { pad, cwd, originator: 'codex-tui', thread_source: 'subagent' }
      })
    const probe = lineWith('')
    const euroAt = Buffer.byteLength(probe.slice(0, probe.indexOf('€')), 'utf8')
    const line = lineWith('x'.repeat(64 * 1024 - 1 - euroAt))
    expect(Buffer.byteLength(line.slice(0, line.indexOf('€')), 'utf8')).toBe(64 * 1024 - 1)
    const meta = await extractCodexMeta(await rollout(line + '\n' + jsonl(TAIL)))
    expect(meta).toMatchObject({ codexSubagent: true, cwd, messageCount: 0 })
  })

  it('falls back to the whole file when the head runs past the size cap', async () => {
    const huge = sessionMeta({ thread_source: 'subagent', base_instructions: 'x'.repeat(1100 * 1024) })
    const meta = await extractCodexMeta(await rollout(jsonl([huge, ...TAIL])))
    // Still hidden — the full read sees the same marker — but the tail WAS read.
    expect(meta).toMatchObject({ codexSubagent: true, messageCount: 1 })
  })

  it('still drops a non-interactive subagent rollout, like the full read', async () => {
    const meta = await extractCodexMeta(
      await rollout(jsonl([sessionMeta({ thread_source: 'subagent', originator: 'codex_exec' }), ...TAIL]))
    )
    expect(meta).toBeNull()
  })
})
