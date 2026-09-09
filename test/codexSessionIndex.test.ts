import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readCodexSessionNames, resolveCodexTitle } from '../src/main/sessions/codexSessionIndex'

const tmpDirs: string[] = []
function freshHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sb-codexidx-'))
  tmpDirs.push(dir)
  return dir
}
function writeIndex(home: string, lines: Array<Record<string, unknown> | string>): void {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
  writeFileSync(path.join(home, 'session_index.jsonl'), text + '\n')
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('readCodexSessionNames', () => {
  it('keeps the newest name per id (append-only, last line wins)', () => {
    const home = freshHome()
    writeIndex(home, [
      { id: 'id-a', thread_name: 'First', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'id-a', thread_name: 'Second', updated_at: '2026-01-02T00:00:00Z' },
      { id: 'id-b', thread_name: 'Bee', updated_at: '2026-01-01T00:00:00Z' }
    ])
    const names = readCodexSessionNames(home)
    expect(names.get('id-a')).toBe('Second')
    expect(names.get('id-b')).toBe('Bee')
  })

  it('treats a newest empty/whitespace name as a cleared rename (id omitted)', () => {
    const home = freshHome()
    writeIndex(home, [
      { id: 'id-a', thread_name: 'Named', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'id-a', thread_name: '   ', updated_at: '2026-01-02T00:00:00Z' }
    ])
    expect(readCodexSessionNames(home).has('id-a')).toBe(false)
  })

  it('returns an empty map when the file is missing', () => {
    expect(readCodexSessionNames(freshHome()).size).toBe(0)
  })

  it('skips malformed lines and parses the rest', () => {
    const home = freshHome()
    writeIndex(home, [
      'not json',
      { id: 'id-a', thread_name: 'Good', updated_at: '2026-01-01T00:00:00Z' },
      '{"partial":'
    ])
    const names = readCodexSessionNames(home)
    expect(names.get('id-a')).toBe('Good')
    expect(names.size).toBe(1)
  })

  it('ignores entries without a string id', () => {
    const home = freshHome()
    writeIndex(home, [
      { thread_name: 'No id', updated_at: '2026-01-01T00:00:00Z' },
      { id: 42, thread_name: 'Numeric id', updated_at: '2026-01-01T00:00:00Z' }
    ])
    expect(readCodexSessionNames(home).size).toBe(0)
  })
})

describe('resolveCodexTitle', () => {
  const base = { rolloutTitle: 'rollout', dbTitle: null, dbFirstUserMessage: null, sessionName: null }

  it('cleans an auto-title without copying the rest of a large prompt', () => {
    const prompt = '`Discuss   the release`\n' + 'Detailed transcript. '.repeat(10000)
    expect(resolveCodexTitle({ ...base, dbTitle: prompt, dbFirstUserMessage: prompt })).toBe('Discuss the release')
  })

  it.each([79, 80, 81, 10000])('bounds an auto-title of length %i', (length) => {
    const prompt = 'A'.repeat(length)
    const expected = length === 79 ? 'A'.repeat(79) : 'A'.repeat(80)
    expect(resolveCodexTitle({ ...base, dbTitle: prompt, dbFirstUserMessage: prompt })).toBe(expected)
  })

  it('falls back when cleaning removes the whole auto-title', () => {
    const prompt = '<command-name>/clear</command-name>'
    expect(resolveCodexTitle({ ...base, dbTitle: prompt, dbFirstUserMessage: prompt })).toBe('rollout')
  })

  it('compares complete values before cleaning and preserves an explicit long name', () => {
    const prefix = 'A'.repeat(90)
    expect(resolveCodexTitle({ ...base, dbTitle: prefix + ' custom', dbFirstUserMessage: prefix + ' prompt' })).toBe(prefix + ' custom')
  })

  it('preserves the durable name over a long auto-title, and cleans again after reset', () => {
    const prompt = 'A'.repeat(300)
    const sources = { ...base, dbTitle: prompt, dbFirstUserMessage: prompt }
    expect(resolveCodexTitle({ ...sources, sessionName: 'Named thread' })).toBe('Named thread')
    expect(resolveCodexTitle({ ...sources, sessionName: '' })).toBe('A'.repeat(80))
  })

  it('prefers a distinct DB title (a fresh rename still in the column)', () => {
    expect(
      resolveCodexTitle({
        ...base,
        dbTitle: 'Custom name',
        dbFirstUserMessage: 'hi there',
        sessionName: 'Index name'
      })
    ).toBe('Custom name')
  })

  it('falls back to the session-index name when the DB title reverted to the first message', () => {
    // The "Renaming bug" scenario: a resume re-derived threads.title back to the first message,
    // but the durable rename still lives in session_index.jsonl.
    expect(
      resolveCodexTitle({
        rolloutTitle: 'first message',
        dbTitle: 'first message',
        dbFirstUserMessage: 'first message',
        sessionName: 'Renaming bug'
      })
    ).toBe('Renaming bug')
  })

  it('keeps the DB auto-title when there is no session-index name', () => {
    expect(
      resolveCodexTitle({ ...base, dbTitle: 'first message', dbFirstUserMessage: 'first message' })
    ).toBe('first message')
  })

  it('uses the session-index name when the DB has no title', () => {
    expect(resolveCodexTitle({ ...base, sessionName: 'Index name' })).toBe('Index name')
  })

  it('falls back to the rollout title when nothing else is set', () => {
    expect(resolveCodexTitle(base)).toBe('rollout')
  })
})
