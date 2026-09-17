import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractPiMetaFromText, parsePiTranscriptText, resolvePiFile } from '../src/main/sessions/piParser'
import { indexConversations } from '../src/main/sessions/indexer'

const header = { type: 'session', version: 3, id: 'pi-session', cwd: '/work/project', timestamp: '2026-09-17T12:00:00Z' }
const entry = (id: string, parentId: string | null, role: string, content: unknown, extra = {}) => ({
  type: 'message', id, parentId, timestamp: '2026-09-17T12:00:01Z',
  message: { role, content, timestamp: 1000, ...extra }
})
const jsonl = (...rows: unknown[]) => [header, ...rows].map((row) => JSON.stringify(row)).join('\n')
const text = (value: string) => [{ type: 'text', text: value }]
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

describe('Pi sessions', () => {
  it('follows the selected branch, while retaining the latest global title', () => {
    const source = jsonl(
      entry('u', null, 'user', 'Original question\nDetails'),
      entry('abandoned', 'u', 'assistant', text('Discard this answer'), { usage: { output: 900 } }),
      { type: 'session_info', id: 'name', parentId: 'abandoned', name: 'Named session' },
      entry('replacement', 'u', 'assistant', text('Keep this answer'), { model: 'model-a', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 } })
    )
    const transcript = parsePiTranscriptText(source)
    expect(transcript.messages.map((message) => message.uuid)).toEqual(['u', 'replacement'])
    expect(transcript.title).toBe('Named session')
    expect(extractPiMetaFromText(source, 77, 88)).toMatchObject({
      agent: 'pi', sessionId: 'pi-session', cwd: '/work/project', model: 'model-a',
      title: 'Named session', messageCount: 2, inputTokens: 33, inputBaseTokens: 10,
      outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 3, contextTokens: 38,
      turnState: 'awaiting', turnEndedAt: 1000, mtime: 77, sizeBytes: 88
    })
  })

  it('preserves tool pairing and images, omits thinking, and counts only conversation prose/images', () => {
    const source = jsonl(
      entry('u', null, 'user', [{ type: 'image', data: 'not-exposed' }]),
      entry('call', 'u', 'assistant', [{ type: 'thinking', thinking: 'private' }, { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'file.ts' } }], { stopReason: 'toolUse' }),
      entry('result', 'call', 'toolResult', text('file contents'), { toolCallId: 'tool-1', isError: true })
    )
    const transcript = parsePiTranscriptText(source)
    expect(transcript.messages[0].blocks).toEqual([{ kind: 'image', alt: 'Attached image' }])
    expect(transcript.messages[1].blocks).toEqual([{ kind: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'file.ts' } }])
    expect(transcript.messages[2]).toMatchObject({ userKind: 'tool_result', blocks: [{ kind: 'tool_result', toolUseId: 'tool-1', text: 'file contents', isError: true }] })
    expect(extractPiMetaFromText(source, 0, 0)).toMatchObject({ messageCount: 1, turnState: 'in_progress', turnEndedAt: null })
    expect(JSON.stringify(transcript)).not.toContain('private')
  })

  it('handles title clears, metadata after compaction, malformed tails and cyclic parents', () => {
    const source = jsonl(
      entry('u', null, 'user', 'First line\nRest'),
      { type: 'session_info', id: 'name', parentId: 'u', name: 'Old name' },
      { type: 'compaction', id: 'compact', parentId: 'name', summary: 'Internal summary' },
      { type: 'session_info', id: 'clear', parentId: 'compact', name: '' }
    ) + '\n{"incomplete"'
    expect(parsePiTranscriptText(source).title).toBe('First line')
    expect(parsePiTranscriptText(source).messages).toHaveLength(1)
    expect(parsePiTranscriptText(jsonl(entry('loop', 'loop', 'user', 'Cycle'))).messages).toHaveLength(1)
    expect(extractPiMetaFromText('{"type":"session","id":"bad"}', 0, 0)).toBeNull()
  })

  it('uses header identity for discovery and includes Pi in the shared index', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'switchboard-pi-'))
    dirs.push(root)
    const piRoot = path.join(root, 'pi')
    await mkdir(path.join(piRoot, '--project--'), { recursive: true })
    const file = path.join(piRoot, '--project--', 'custom-filename.jsonl')
    await writeFile(file, jsonl(entry('u', null, 'user', 'A Pi question')))
    await writeFile(path.join(piRoot, 'empty.jsonl'), jsonl())
    await writeFile(path.join(piRoot, 'broken.jsonl'), 'not json')
    expect(await resolvePiFile('pi-session', piRoot)).toBe(file)
    expect(await resolvePiFile('../missing', piRoot)).toBeNull()
    const index = await indexConversations(path.join(root, 'claude'), path.join(root, 'codex'), new Map(), piRoot)
    expect(index.groups).toHaveLength(1)
    expect(index.groups[0].conversations).toHaveLength(1)
    expect(index.groups[0].conversations[0]).toMatchObject({ agent: 'pi', title: 'A Pi question' })
  })
})
