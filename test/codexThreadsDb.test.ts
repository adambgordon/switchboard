import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// node:sqlite is a recent built-in; skip the suite where the test runner's Node lacks it (the app
// itself runs under Electron's Node 24+, which has it — verified). Guarded so the file never errors
// on load when the module is absent.
const require = createRequire(import.meta.url)
let DatabaseSync: typeof import('node:sqlite').DatabaseSync | undefined
try {
  DatabaseSync = require('node:sqlite').DatabaseSync
} catch {
  DatabaseSync = undefined
}

const tmpDirs: string[] = []
function freshHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sb-codexdb-'))
  tmpDirs.push(dir)
  return dir
}
function makeStateDb(home: string, n: number, rows: Array<[string, string]>, withTable = true): void {
  const db = new DatabaseSync!(path.join(home, `state_${n}.sqlite`))
  if (withTable) {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)')
    const ins = db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)')
    for (const [id, title] of rows) ins.run(id, title)
  } else {
    db.exec('CREATE TABLE other (x TEXT)')
  }
  db.close()
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

describe.skipIf(!DatabaseSync)('readCodexTitles', () => {
  it('maps id -> title and drops empty/whitespace titles', async () => {
    const home = freshHome()
    makeStateDb(home, 5, [
      ['id-a', 'Alpha thread'],
      ['id-b', '  '],
      ['id-c', '']
    ])
    const { readCodexTitles } = await import('../src/main/sessions/codexThreadsDb')
    const titles = readCodexTitles(home)
    expect(titles.get('id-a')).toBe('Alpha thread')
    expect(titles.has('id-b')).toBe(false)
    expect(titles.has('id-c')).toBe(false)
  })

  it('reads the newest state_<N>.sqlite when several exist', async () => {
    const home = freshHome()
    makeStateDb(home, 3, [['id-a', 'OLD title']])
    makeStateDb(home, 5, [['id-a', 'NEW title']])
    const { readCodexTitles } = await import('../src/main/sessions/codexThreadsDb')
    expect(readCodexTitles(home).get('id-a')).toBe('NEW title')
  })

  it('returns an empty map when the home has no state DB', async () => {
    const home = freshHome()
    const { readCodexTitles } = await import('../src/main/sessions/codexThreadsDb')
    expect(readCodexTitles(home).size).toBe(0)
  })

  it('returns an empty map (never throws) when the threads table is missing', async () => {
    const home = freshHome()
    makeStateDb(home, 5, [], false)
    const { readCodexTitles } = await import('../src/main/sessions/codexThreadsDb')
    expect(readCodexTitles(home).size).toBe(0)
  })
})
