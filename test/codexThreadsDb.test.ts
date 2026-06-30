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
function makeStateDb(
  home: string,
  n: number,
  rows: Array<[string, string, number?, string?]>,
  withTable = true
): void {
  const db = new DatabaseSync!(path.join(home, `state_${n}.sqlite`))
  if (withTable) {
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, first_user_message TEXT, archived INTEGER)'
    )
    const ins = db.prepare(
      'INSERT INTO threads (id, title, first_user_message, archived) VALUES (?, ?, ?, ?)'
    )
    for (const [id, title, archived = 0, firstUserMessage = ''] of rows)
      ins.run(id, title, firstUserMessage, archived)
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

describe.skipIf(!DatabaseSync)('readCodexThreads', () => {
  it('maps id -> { title, firstUserMessage, archived }, keeps raw values, and flags archived rows', async () => {
    const home = freshHome()
    makeStateDb(home, 5, [
      ['id-a', 'Alpha thread', 0],
      ['id-b', '  ', 0], // raw — the indexer applies the non-empty check, not the reader
      ['id-c', 'Archived one', 1],
      ['id-d', 'Title D', 0, 'first msg of d']
    ])
    const { readCodexThreads } = await import('../src/main/sessions/codexThreadsDb')
    const threads = readCodexThreads(home)
    expect(threads.get('id-a')).toEqual({ title: 'Alpha thread', firstUserMessage: '', archived: false })
    expect(threads.get('id-b')).toEqual({ title: '  ', firstUserMessage: '', archived: false })
    expect(threads.get('id-c')).toEqual({ title: 'Archived one', firstUserMessage: '', archived: true })
    expect(threads.get('id-d')).toEqual({
      title: 'Title D',
      firstUserMessage: 'first msg of d',
      archived: false
    })
  })

  it('reads the newest state_<N>.sqlite when several exist', async () => {
    const home = freshHome()
    makeStateDb(home, 3, [['id-a', 'OLD title', 0]])
    makeStateDb(home, 5, [['id-a', 'NEW title', 0]])
    const { readCodexThreads } = await import('../src/main/sessions/codexThreadsDb')
    expect(readCodexThreads(home).get('id-a')?.title).toBe('NEW title')
  })

  it('returns an empty map when the home has no state DB', async () => {
    const home = freshHome()
    const { readCodexThreads } = await import('../src/main/sessions/codexThreadsDb')
    expect(readCodexThreads(home).size).toBe(0)
  })

  it('returns an empty map (never throws) when the threads table is missing', async () => {
    const home = freshHome()
    makeStateDb(home, 5, [], false)
    const { readCodexThreads } = await import('../src/main/sessions/codexThreadsDb')
    expect(readCodexThreads(home).size).toBe(0)
  })
})
