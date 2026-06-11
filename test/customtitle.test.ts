import { describe, it, expect, afterAll } from 'vitest'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseTranscript, extractMeta } from '../src/main/sessions/parser'

// Scratch dir; honors CLAUDE_CODE_TMPDIR if set, else the system temp.
const TMP = join(process.env.CLAUDE_CODE_TMPDIR ?? tmpdir(), 'sb-customtitle-test')

async function writeSession(lines: object[]): Promise<string> {
  await mkdir(TMP, { recursive: true })
  const fp = join(TMP, `${randomUUID()}.jsonl`)
  await writeFile(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return fp
}

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('customTitle (/rename) precedence', () => {
  it('prefers customTitle over aiTitle in both extractMeta and parseTranscript', async () => {
    const fp = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'hello' } },
      { type: 'ai-title', sessionId: 's', aiTitle: 'Auto Generated Title' },
      { type: 'custom-title', sessionId: 's', customTitle: 'my-renamed-slug' }
    ])
    expect((await extractMeta(fp))?.title).toBe('my-renamed-slug')
    expect((await parseTranscript(fp)).title).toBe('my-renamed-slug')
  })

  it('uses the LAST customTitle when renamed more than once', async () => {
    const fp = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'hello' } },
      { type: 'custom-title', sessionId: 's', customTitle: 'first-name' },
      { type: 'custom-title', sessionId: 's', customTitle: 'second-name' }
    ])
    expect((await extractMeta(fp))?.title).toBe('second-name')
  })

  it('falls back to aiTitle when there is no customTitle', async () => {
    const fp = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'hello' } },
      { type: 'ai-title', sessionId: 's', aiTitle: 'Auto Generated Title' }
    ])
    expect((await extractMeta(fp))?.title).toBe('Auto Generated Title')
  })

  it('cleans command-wrapper junk in a branch-style customTitle (falls through to a clean source)', async () => {
    const fp = await writeSession([
      { type: 'user', cwd: '/x', sessionId: 's', uuid: 'u1', message: { role: 'user', content: 'a real prompt' } },
      {
        type: 'custom-title',
        sessionId: 's',
        customTitle: '<command-message>deep-review</command-message> <command-name>/deep-review</command-name>'
      }
    ])
    const title = (await extractMeta(fp))?.title ?? ''
    expect(title).not.toContain('<command-')
    expect(title.length).toBeGreaterThan(0)
  })
})
