import { describe, it, expect, afterAll } from 'vitest'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseTranscript, extractMeta } from '../src/main/sessions/parser'
import { appendCustomTitle } from '../src/main/sessions/rename'

// Scratch dir; honors CLAUDE_CODE_TMPDIR if set, else the system temp.
const TMP = join(process.env.CLAUDE_CODE_TMPDIR ?? tmpdir(), 'sb-rename-test')

// Write a fixture session and return its path + the generated sessionId (the filename stem — what
// the parser uses; the in-line `sessionId` fields are scaffolding only, so they stay a literal).
async function writeSession(lines: object[]): Promise<{ fp: string; sessionId: string }> {
  await mkdir(TMP, { recursive: true })
  const sessionId = randomUUID()
  const fp = join(TMP, `${sessionId}.jsonl`)
  await writeFile(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { fp, sessionId }
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('appendCustomTitle (rename)', () => {
  it('sets the title by appending a custom-title line (wins in extractMeta + parseTranscript)', async () => {
    const { fp, sessionId } = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'hello' } },
      { type: 'ai-title', sessionId: 's', aiTitle: 'Auto Generated Title' }
    ])
    await appendCustomTitle(fp, sessionId, 'my new name')
    expect((await extractMeta(fp))?.title).toBe('my new name')
    expect((await parseTranscript(fp)).title).toBe('my new name')
  })

  it('uses the latest appended title when renamed twice', async () => {
    const { fp, sessionId } = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'hello' } }
    ])
    await appendCustomTitle(fp, sessionId, 'first')
    await appendCustomTitle(fp, sessionId, 'second')
    expect((await extractMeta(fp))?.title).toBe('second')
  })

  it('an empty title reverts to the auto-generated title (the reset path)', async () => {
    const { fp, sessionId } = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'a typed prompt' } },
      { type: 'ai-title', sessionId: 's', aiTitle: 'Auto Generated Title' }
    ])
    await appendCustomTitle(fp, sessionId, 'temporary name')
    expect((await extractMeta(fp))?.title).toBe('temporary name')
    await appendCustomTitle(fp, sessionId, '')
    expect((await extractMeta(fp))?.title).toBe('Auto Generated Title')
  })

  it('writes a single valid JSONL line of the expected shape, trimmed', async () => {
    const { fp, sessionId } = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'hi' } }
    ])
    await appendCustomTitle(fp, sessionId, '  trimmed  ')
    const lines = (await readFile(fp, 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[lines.length - 1])).toEqual({
      type: 'custom-title',
      customTitle: 'trimmed',
      sessionId
    })
  })
})
