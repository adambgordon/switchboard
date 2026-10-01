import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentKind, ConversationMeta } from '../src/shared/types'
import type { JobPriority } from '../src/main/sessions/jobQueue'
import { MetaStore } from '../src/main/sessions/metaStore'

let root: string
let userData: string
let sessions: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'meta-store-'))
  userData = path.join(root, 'userData')
  sessions = path.join(root, 'sessions')
  mkdirSync(userData)
  mkdirSync(sessions)
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

let clock = 1_700_000_000
/** Write a session file whose content is its title, with a distinct mtime each write. */
function writeSession(name: string, title: string): string {
  const file = path.join(sessions, name)
  writeFileSync(file, title)
  clock += 10
  utimesSync(file, clock, clock)
  return file
}

/** An extractor that parses "title = file content", recording every call and its priority. */
function recordingExtract(overrides: { titlePrefix?: string } = {}) {
  const calls: { file: string; priority: JobPriority }[] = []
  const extract = async (agent: AgentKind, file: string, priority: JobPriority): Promise<ConversationMeta | null> => {
    calls.push({ file: path.basename(file), priority })
    const text = readFileSync(file, 'utf8')
    if (text === 'none') return null
    const st = statSync(file)
    return {
      sessionId: path.basename(file),
      agent,
      cwd: '/repo',
      title: `${overrides.titlePrefix ?? ''}${text}`,
      mtime: st.mtimeMs,
      sizeBytes: st.size,
      messageCount: 1
    } as ConversationMeta
  }
  return { calls, extract }
}

/** Run one index pass over `files` the way the indexer does: begin, resolve each, end. */
async function pass(store: MetaStore, files: string[]): Promise<(string | null)[]> {
  store.beginPass()
  const metas = await Promise.all(files.map((f) => store.resolve('claude', f)))
  store.endPass()
  return metas.map((m) => m?.title ?? null)
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function store(fingerprint: string | null, extract = recordingExtract().extract): MetaStore {
  return new MetaStore({ dir: userData, fingerprint, extract })
}

describe('MetaStore — first ever launch', () => {
  it('parses every file in the foreground before answering, so the first list is complete', async () => {
    const a = writeSession('a.jsonl', 'A')
    const b = writeSession('b.jsonl', 'B')
    const rec = recordingExtract()
    const s = store('fp1', rec.extract)
    expect(await pass(s, [a, b])).toEqual(['A', 'B'])
    expect(rec.calls.map((c) => c.priority)).toEqual(['foreground', 'foreground'])
    expect(s.pendingCount()).toBe(0)
  })
})

describe('MetaStore — relaunch with the same parsers', () => {
  it('answers unchanged files from disk without parsing anything', async () => {
    const a = writeSession('a.jsonl', 'A')
    const first = store('fp1')
    await pass(first, [a])
    first.flush()

    const rec = recordingExtract()
    const second = store('fp1', rec.extract)
    expect(await pass(second, [a])).toEqual(['A'])
    expect(rec.calls).toEqual([])
    expect(second.pendingCount()).toBe(0)
  })

  it('answers a file changed while closed from its old entry, then re-parses it in the background', async () => {
    const a = writeSession('a.jsonl', 'A')
    const first = store('fp1')
    await pass(first, [a])
    first.flush()
    writeSession('a.jsonl', 'A2')

    const rec = recordingExtract()
    const second = store('fp1', rec.extract)
    expect(await pass(second, [a])).toEqual(['A'])
    expect(rec.calls).toEqual([])
    expect(second.pendingCount()).toBe(1)

    second.revalidate(() => {})
    await settle()
    expect(rec.calls).toEqual([{ file: 'a.jsonl', priority: 'background' }])
    expect(await pass(second, [a])).toEqual(['A2'])
    expect(second.pendingCount()).toBe(0)
  })

  it('leaves a file new since the last quit out of the launch answer, then adds it', async () => {
    const a = writeSession('a.jsonl', 'A')
    const first = store('fp1')
    await pass(first, [a])
    first.flush()
    const b = writeSession('b.jsonl', 'B')

    const rec = recordingExtract()
    const second = store('fp1', rec.extract)
    expect(await pass(second, [a, b])).toEqual(['A', null])
    expect(rec.calls).toEqual([])
    second.revalidate(() => {})
    await settle()
    expect(await pass(second, [a, b])).toEqual(['A', 'B'])
  })
})

describe('MetaStore — relaunch after the parsers changed', () => {
  it("serves the older build's entries, then re-parses all of them in the background", async () => {
    const a = writeSession('a.jsonl', 'A')
    const b = writeSession('b.jsonl', 'B')
    const old = store('fp-old')
    await pass(old, [a, b])
    old.flush()

    const rec = recordingExtract({ titlePrefix: 'new:' })
    const upgraded = store('fp-new', rec.extract)
    expect(await pass(upgraded, [a, b])).toEqual(['A', 'B'])
    expect(rec.calls).toEqual([])
    expect(upgraded.pendingCount()).toBe(2)

    const progress: number[] = []
    upgraded.revalidate((left) => progress.push(left))
    await settle()
    expect(rec.calls.map((c) => c.priority)).toEqual(['background', 'background'])
    expect(progress).toEqual([1, 0])
    expect(await pass(upgraded, [a, b])).toEqual(['new:A', 'new:B'])
  })

  it('does not treat a file named for another build as this build’s', async () => {
    const a = writeSession('a.jsonl', 'A')
    const old = store('fp-old')
    await pass(old, [a])
    old.flush()
    // The new build saves under its own name; the old file survives as the seed for a downgrade.
    const upgraded = store('fp-new', recordingExtract({ titlePrefix: 'new:' }).extract)
    await pass(upgraded, [a])
    upgraded.revalidate(() => {})
    await settle()
    upgraded.flush()
    expect(readdirSync(path.join(userData, 'session-meta-cache')).sort()).toEqual(['fp-new.json', 'fp-old.json'])

    const rec = recordingExtract({ titlePrefix: 'newer:' })
    const again = store('fp-new', rec.extract)
    expect(await pass(again, [a])).toEqual(['new:A'])
    expect(rec.calls).toEqual([])
  })

  it('keeps only the most recent older build file', async () => {
    const a = writeSession('a.jsonl', 'A')
    for (const fp of ['fp1', 'fp2', 'fp3']) {
      const s = store(fp)
      await pass(s, [a])
      s.revalidate(() => {})
      await settle()
      s.flush()
      // Order the files by write time, oldest first.
      clock += 10
      utimesSync(path.join(userData, 'session-meta-cache', `${fp}.json`), clock, clock)
    }
    const s = store('fp4')
    await pass(s, [a])
    s.revalidate(() => {})
    await settle()
    s.flush()
    expect(readdirSync(path.join(userData, 'session-meta-cache')).sort()).toEqual(['fp3.json', 'fp4.json'])
  })
})

describe('MetaStore — after the launch pass', () => {
  async function relaunchedWithPending() {
    const a = writeSession('a.jsonl', 'A')
    const first = store('fp1')
    await pass(first, [a])
    first.flush()
    writeSession('a.jsonl', 'A2')
    const rec = recordingExtract()
    const s = store('fp1', rec.extract)
    await pass(s, [a])
    return { a, s, rec }
  }

  it('keeps serving a queued file from its old entry while it is unchanged', async () => {
    const { a, s, rec } = await relaunchedWithPending()
    expect(await pass(s, [a])).toEqual(['A'])
    expect(rec.calls).toEqual([])
  })

  it('parses a queued file in the foreground once it changes again, and ignores the stale background result', async () => {
    const { a, s, rec } = await relaunchedWithPending()
    writeSession('a.jsonl', 'A3')
    expect(await pass(s, [a])).toEqual(['A3'])
    expect(rec.calls).toEqual([{ file: 'a.jsonl', priority: 'foreground' }])
    expect(s.pendingCount()).toBe(0)
  })

  it('does not let a background result that lands after a foreground re-parse overwrite it', async () => {
    const a = writeSession('a.jsonl', 'A')
    const first = store('fp1')
    await pass(first, [a])
    first.flush()
    writeSession('a.jsonl', 'A2')

    // Background parses are held until released; foreground ones run at once.
    const rec = recordingExtract()
    let release: (() => void) | null = null
    let backgroundSnapshot: ConversationMeta | null = null
    const s = store('fp1', async (agent, file, priority) => {
      if (priority === 'foreground') return rec.extract(agent, file, priority)
      backgroundSnapshot = await rec.extract(agent, file, priority) // reads 'A2' now
      await new Promise<void>((r) => (release = r))
      return backgroundSnapshot
    })
    await pass(s, [a])
    s.revalidate(() => {})
    await settle()
    writeSession('a.jsonl', 'A3')
    expect(await pass(s, [a])).toEqual(['A3'])
    release!()
    await settle()
    expect((backgroundSnapshot as ConversationMeta | null)?.title).toBe('A2')
    expect(await pass(s, [a])).toEqual(['A3'])
    // A stale result that overwrote the fresh entry would also read 'A3' — after an extra re-parse.
    expect(rec.calls.filter((c) => c.priority === 'foreground')).toHaveLength(1)
  })

  it('parses a changed file that was never queued in the foreground', async () => {
    const a = writeSession('a.jsonl', 'A')
    const rec = recordingExtract()
    const s = store('fp1', rec.extract)
    await pass(s, [a])
    writeSession('a.jsonl', 'A2')
    expect(await pass(s, [a])).toEqual(['A2'])
    expect(rec.calls.map((c) => c.priority)).toEqual(['foreground', 'foreground'])
  })

  it('answers null for a file whose parse fails, without failing the pass', async () => {
    const a = writeSession('a.jsonl', 'A')
    const s = new MetaStore({ dir: userData, fingerprint: 'fp1', extract: () => Promise.reject(new Error('boom')) })
    expect(await pass(s, [a])).toEqual([null])
  })
})

describe('MetaStore — persistence', () => {
  it('forgets files a pass no longer lists, and does not bring them back from disk', async () => {
    const a = writeSession('a.jsonl', 'A')
    const b = writeSession('b.jsonl', 'B')
    const s = store('fp1')
    await pass(s, [a, b])
    s.flush()
    await pass(s, [a])
    s.flush()

    const rec = recordingExtract()
    const again = store('fp1', rec.extract)
    expect(await pass(again, [a, b])).toEqual(['A', null])
  })

  it('keeps an entry another process wrote, after this one loaded, for a file this one has not parsed', async () => {
    const a = writeSession('a.jsonl', 'A')
    const seed = store('fp1')
    await pass(seed, [a])
    seed.flush()
    const b = writeSession('b.jsonl', 'B')

    // Both processes launch from the same file; b is new to both, so both leave it out at launch.
    const s = store('fp1')
    const other = store('fp1')
    await pass(s, [a, b])
    await pass(other, [a, b])
    // Only the other process gets as far as parsing b and saving.
    other.revalidate(() => {})
    await settle()
    other.flush()
    // This process then has a change of its own to save (a was edited), but never parsed b — its
    // save must not drop the other's entry for b.
    writeSession('a.jsonl', 'A2')
    expect(await pass(s, [a, b])).toEqual(['A2', null])
    s.flush()
    const onDisk = JSON.parse(readFileSync(path.join(userData, 'session-meta-cache', 'fp1.json'), 'utf8'))
    expect(Object.keys(onDisk.entries).map((f) => path.basename(f)).sort()).toEqual(['a.jsonl', 'b.jsonl'])
  })

  it('forgets a file that can no longer be read', async () => {
    const a = writeSession('a.jsonl', 'A')
    const s = store('fp1')
    await pass(s, [a])
    rmSync(a)
    expect(await pass(s, [a])).toEqual([null])
  })

  for (const [name, contents] of [
    ['corrupt JSON', () => '{not json'],
    // A well-formed, otherwise-valid entry — only the version marks it unusable.
    ['a different format version', (a: string) => {
      const st = statSync(a)
      const entry = { sessionId: 'a', agent: 'claude', cwd: '/repo', title: 'OLD', mtime: st.mtimeMs, sizeBytes: st.size, messageCount: 1 }
      return JSON.stringify({ version: 999, entries: { [a]: entry }, stale: {} })
    }]
  ] as const) {
    it(`treats ${name} as an empty cache`, async () => {
      const a = writeSession('a.jsonl', 'A')
      mkdirSync(path.join(userData, 'session-meta-cache'), { recursive: true })
      writeFileSync(path.join(userData, 'session-meta-cache', 'fp1.json'), contents(a))
      const rec = recordingExtract()
      expect(await pass(store('fp1', rec.extract), [a])).toEqual(['A'])
      expect(rec.calls.map((c) => c.priority)).toEqual(['foreground'])
    })
  }

  it('drops malformed entries and keeps the rest', async () => {
    const a = writeSession('a.jsonl', 'A')
    const b = writeSession('b.jsonl', 'B')
    const st = statSync(a)
    mkdirSync(path.join(userData, 'session-meta-cache'), { recursive: true })
    writeFileSync(
      path.join(userData, 'session-meta-cache', 'fp1.json'),
      JSON.stringify({
        version: 1,
        entries: {
          [a]: { sessionId: 'a', agent: 'claude', cwd: '/repo', title: 'A', mtime: st.mtimeMs, sizeBytes: st.size, messageCount: 1 },
          [b]: { sessionId: 'b', agent: 'nope', title: 'B' }
        },
        stale: {}
      })
    )
    const rec = recordingExtract()
    const s = store('fp1', rec.extract)
    // a is served from disk; b's entry was dropped, so b is new — left out, then parsed.
    expect(await pass(s, [a, b])).toEqual(['A', null])
    expect(rec.calls).toEqual([])
  })

  it('persists nothing, and trusts nothing, when the fingerprint is unknown', async () => {
    const a = writeSession('a.jsonl', 'A')
    const s = store(null)
    await pass(s, [a])
    s.flush()
    let names: string[] = []
    try {
      names = readdirSync(path.join(userData, 'session-meta-cache'))
    } catch {
      /* never created */
    }
    expect(names).toEqual([])
  })
})
