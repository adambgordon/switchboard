import { access, mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existenceProbe, indexConversations } from '../src/main/sessions/indexer'
import { ProjectRoots } from '../src/main/sessions/projectRoot'
import { listCodexRollouts } from '../src/main/sessions/codexParser'

/** Base for test temp dirs. */
const TMP_BASE = tmpdir()

/** A nonexistent Codex sessions root, so these Claude-focused tests stay hermetic — the indexer now
 *  also scans `~/.codex/sessions` by default, which would otherwise pull whatever Codex
 *  conversations happen to exist on the host into these assertions. */
const NO_CODEX = path.join(TMP_BASE, 'switchboard-no-codex-DOES-NOT-EXIST')

/** Serialize line-objects to JSONL text. */
function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

/** A minimal valid user/assistant line carrying a cwd. */
function msgLine(role: 'user' | 'assistant', cwd: string, content: string): unknown {
  return {
    type: role,
    uuid: randomUUID(),
    isSidechain: false,
    timestamp: '2026-05-29T20:00:00.000Z',
    cwd,
    gitBranch: 'main',
    version: '2.1.156',
    message: { role, content }
  }
}

/**
 * Write a session file under `<root>/<encodedDir>/<id>.jsonl` and stamp its
 * mtime so ordering assertions are deterministic (sequential writes can
 * otherwise collide at ms resolution).
 */
async function writeSession(
  root: string,
  encodedDir: string,
  lines: unknown[],
  mtimeMs: number
): Promise<{ id: string; file: string }> {
  const dir = path.join(root, encodedDir)
  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  const file = path.join(dir, `${id}.jsonl`)
  await writeFile(file, jsonl(lines), 'utf8')
  const seconds = mtimeMs / 1000
  await utimes(file, seconds, seconds)
  return { id, file }
}

async function writeCodexRollout(
  root: string,
  cwd: string,
  threadSource: string | undefined,
  mtimeMs: number,
  metadata: Record<string, unknown> = {}
): Promise<string> {
  const dir = path.join(root, '2026', '07', '27')
  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  const file = path.join(dir, `rollout-2026-07-27T12-00-00-${id}.jsonl`)
  await writeFile(
    file,
    jsonl([
      {
        timestamp: '2026-07-27T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          id,
          session_id: threadSource === 'subagent' ? randomUUID() : id,
          cwd,
          originator: 'codex-tui',
          source: threadSource === 'subagent' ? { subagent: { other: 'guardian' } } : 'cli',
          thread_source: threadSource,
          cli_version: '0.145.0',
          ...metadata
        }
      },
      {
        timestamp: '2026-07-27T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: `${threadSource} prompt` }
      },
      {
        timestamp: '2026-07-27T12:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: `${threadSource} reply` }
      }
    ]),
    'utf8'
  )
  const seconds = mtimeMs / 1000
  await utimes(file, seconds, seconds)
  return id
}

const CWD_A = '/home/user/project-one'
const CWD_B = '/home/user/project-two'

describe('indexConversations', () => {
  let root: string
  // Captured ids for targeted assertions.
  let aOld: string
  let aNew: string
  let bOnly: string

  beforeAll(async () => {
    root = await mkdtemp(path.join(TMP_BASE, 'indexer-test-'))

    // Project dir 1 -> two sessions in CWD_A (different mtimes).
    const r1 = await writeSession(
      root,
      '-home-user-project-one',
      [msgLine('user', CWD_A, 'older session in A'), msgLine('assistant', CWD_A, 'reply')],
      1_000_000_000_000 // older
    )
    aOld = r1.id
    const r2 = await writeSession(
      root,
      '-home-user-project-one',
      [msgLine('user', CWD_A, 'newer session in A')],
      2_000_000_000_000 // newer
    )
    aNew = r2.id

    // An empty / 0-message file in the same dir — must be DROPPED.
    await writeSession(
      root,
      '-home-user-project-one',
      [
        { type: 'mode', mode: 'normal', sessionId: 'x' },
        { type: 'last-prompt', lastPrompt: 'orphan', sessionId: 'x', cwd: CWD_A }
      ],
      3_000_000_000_000 // newest mtime, but no messages -> dropped
    )

    // Project dir 2 -> one session in CWD_B.
    const r3 = await writeSession(
      root,
      '-home-user-project-two',
      [msgLine('user', CWD_B, 'only session in B')],
      1_500_000_000_000
    )
    bOnly = r3.id

    // A stray non-jsonl file that must be ignored.
    await writeFile(path.join(root, '-home-user-project-one', 'notes.txt'), 'ignore me', 'utf8')
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('groups conversations by exact cwd', async () => {
    const { groups } = await indexConversations(root, NO_CODEX)
    const byCwd = new Map(groups.map((g) => [g.cwd, g]))

    expect(byCwd.has(CWD_A)).toBe(true)
    expect(byCwd.has(CWD_B)).toBe(true)
    expect(byCwd.get(CWD_A)!.conversations).toHaveLength(2)
    expect(byCwd.get(CWD_B)!.conversations).toHaveLength(1)
  })

  it('drops 0-message conversations', async () => {
    const { groups } = await indexConversations(root, NO_CODEX)
    const a = groups.find((g) => g.cwd === CWD_A)!
    const ids = a.conversations.map((c) => c.sessionId)
    expect(ids).toContain(aOld)
    expect(ids).toContain(aNew)
    expect(ids).toHaveLength(2) // the empty file is not present
  })

  it('sorts conversations within a group by mtime desc', async () => {
    const { groups } = await indexConversations(root, NO_CODEX)
    const a = groups.find((g) => g.cwd === CWD_A)!
    expect(a.conversations.map((c) => c.sessionId)).toEqual([aNew, aOld])
    expect(a.conversations[0].mtime).toBeGreaterThan(a.conversations[1].mtime)
  })

  it('sets label to the basename of the cwd', async () => {
    const { groups } = await indexConversations(root, NO_CODEX)
    expect(groups.find((g) => g.cwd === CWD_A)!.label).toBe('project-one')
    expect(groups.find((g) => g.cwd === CWD_B)!.label).toBe('project-two')
  })

  it('sets latestMtime per group and sorts groups by latestMtime desc', async () => {
    const { groups } = await indexConversations(root, NO_CODEX)
    const a = groups.find((g) => g.cwd === CWD_A)!
    const b = groups.find((g) => g.cwd === CWD_B)!

    // Group A's latest is the newer A session (empty newest file is excluded).
    expect(a.latestMtime).toBe(2_000_000_000_000)
    expect(b.latestMtime).toBe(1_500_000_000_000)

    // Groups ordered by latestMtime desc => A before B.
    const order = groups.map((g) => g.cwd)
    expect(order.indexOf(CWD_A)).toBeLessThan(order.indexOf(CWD_B))
  })

  it('contains the single B session', async () => {
    const { groups } = await indexConversations(root, NO_CODEX)
    const b = groups.find((g) => g.cwd === CWD_B)!
    expect(b.conversations.map((c) => c.sessionId)).toEqual([bOnly])
  })
})

describe('indexConversations Claude session-kind filtering', () => {
  let root: string
  let interactive: string
  let background: string

  beforeAll(async () => {
    root = await mkdtemp(path.join(TMP_BASE, 'indexer-bg-test-'))

    // A normal interactive session in CWD_A — must be KEPT.
    const ok = await writeSession(
      root,
      '-home-user-project-one',
      [msgLine('user', CWD_A, 'interactive session')],
      1_000_000_000_000
    )
    interactive = ok.id

    const bg = await writeSession(
      root,
      '-home-user-project-one',
      [
        {
          type: 'user',
          uuid: randomUUID(),
          isSidechain: false,
          timestamp: '2026-05-29T20:01:00.000Z',
          cwd: CWD_A,
          sessionKind: 'bg',
          message: { role: 'user', content: 'backgrounded continuation' }
        }
      ],
      2_000_000_000_000
    )
    background = bg.id

    for (const [sessionKind, mtime] of [
      ['daemon', 3_000_000_000_000],
      ['daemon-worker', 4_000_000_000_000]
    ] as const) {
      await writeSession(
        root,
        '-home-user-project-one',
        [
          {
            type: 'user',
            uuid: randomUUID(),
            isSidechain: false,
            timestamp: '2026-05-29T20:02:00.000Z',
            cwd: CWD_A,
            sessionKind,
            message: { role: 'user', content: `${sessionKind} internal process` }
          }
        ],
        mtime
      )
    }
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps bg transcripts as independent rows and drops daemon internals', async () => {
    const { groups } = await indexConversations(root, NO_CODEX)
    const a = groups.find((g) => g.cwd === CWD_A)
    expect(a).toBeDefined()
    const ids = a!.conversations.map((c) => c.sessionId)
    expect(ids).toEqual([background, interactive])
    expect(a!.conversations[0].sessionKind).toBe('bg')
  })
})

describe('indexConversations headless Claude filtering', () => {
  it('omits a headless transcript without hiding it, and shows it once an interactive line lands', async () => {
    const root = await mkdtemp(path.join(TMP_BASE, 'indexer-headless-'))
    try {
      const stamped = (entrypoint: string, content: string): unknown => ({
        ...(msgLine('user', CWD_A, content) as object),
        entrypoint
      })
      const kept = await writeSession(root, '-home-user-project-one', [stamped('cli', 'interactive')], 1_000_000_000_000)
      const probeLines = [stamped('sdk-cli', 'one-shot probe')]
      const probe = await writeSession(root, '-home-user-project-one', probeLines, 2_000_000_000_000)

      const cache = new Map()
      const first = await indexConversations(root, NO_CODEX, cache)
      expect(first.groups.flatMap((g) => g.conversations.map((c) => c.sessionId))).toEqual([kept.id])
      // Omitted from the list only: the hidden set is sticky for the app's lifetime, so a headless id
      // there would keep a later interactive resume hidden too.
      expect(first.hiddenSessionIds).toEqual([])

      await writeFile(probe.file, jsonl([...probeLines, stamped('cli', 'resumed interactively')]), 'utf8')
      await utimes(probe.file, 3_000_000_000, 3_000_000_000)
      const second = await indexConversations(root, NO_CODEX, cache)
      expect(second.groups.flatMap((g) => g.conversations.map((c) => c.sessionId))).toEqual([probe.id, kept.id])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('indexConversations Codex subagent filtering', () => {
  it('reports hidden ids independently of visible groups and retains their cached metadata', async () => {
    const root = await mkdtemp(path.join(TMP_BASE, 'indexer-hidden-'))
    const codexRoot = path.join(root, 'sessions')
    try {
      const parent = await writeCodexRollout(codexRoot, CWD_A, 'user', 1000000)
      const guardian = await writeCodexRollout(codexRoot, CWD_A, 'guardian_review', 2000000)
      const structured = await writeCodexRollout(codexRoot, CWD_A, undefined, 3000000, { source: { subagent: {} } })
      const cache = new Map()
      const first = await indexConversations(path.join(root, 'no-claude'), codexRoot, cache)
      expect(first.groups.flatMap((g) => g.conversations.map((c) => c.sessionId))).toEqual([parent])
      expect(first.hiddenSessionIds).toEqual([guardian, structured].sort())
      const cached = [...cache.values()].find((meta) => meta.sessionId === guardian)
      expect(cached?.codexSubagent).toBe(true)
      const second = await indexConversations(path.join(root, 'no-claude'), codexRoot, cache)
      expect([...cache.values()].find((meta) => meta.sessionId === guardian)).toBe(cached)
      expect(second).toEqual(first)
      const next = await writeCodexRollout(codexRoot, CWD_A, 'guardian_review', 4000000)
      const third = await indexConversations(path.join(root, 'no-claude'), codexRoot, cache)
      expect(third.groups).toEqual(first.groups)
      expect(third.hiddenSessionIds).toEqual([guardian, structured, next].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the parent conversation and drops its subagent thread', async () => {
    const root = await mkdtemp(path.join(TMP_BASE, 'indexer-codex-subagent-test-'))
    const codexRoot = path.join(root, 'sessions')
    try {
      const parent = await writeCodexRollout(codexRoot, CWD_A, 'user', 1_000_000_000_000)
      await writeCodexRollout(codexRoot, CWD_A, 'subagent', 2_000_000_000_000)

      const { groups } = await indexConversations(path.join(root, 'no-claude'), codexRoot)

      expect(groups).toHaveLength(1)
      expect(groups[0].conversations.map((conversation) => conversation.sessionId)).toEqual([parent])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('indexConversations project roots and existence', () => {
  it('tags each group with its project, whether it is a worktree, and whether its cwd exists', async () => {
    const base = await realpath(await mkdtemp(path.join(TMP_BASE, 'indexer-roots-')))
    const root = path.join(base, 'claude')
    try {
      const repo = path.join(base, 'repo')
      const sub = path.join(repo, 'src')
      const wt = path.join(base, 'work', 'wt')
      const gone = path.join(base, 'deleted')
      await mkdir(path.join(repo, '.git'), { recursive: true })
      await mkdir(sub, { recursive: true })
      await mkdir(wt, { recursive: true })
      await writeFile(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`)
      let t = 1_000_000_000_000
      for (const cwd of [repo, sub, wt, gone]) {
        await writeSession(root, cwd.replace(/[/.]/g, '-'), [msgLine('user', cwd, 'hello')], (t += 1000))
      }

      const roots = new ProjectRoots({ home: path.join(base, 'home') })
      let told: string[] = []
      const { groups } = await indexConversations(root, NO_CODEX, undefined, {
        resolveRoots: (cwds, missing) => {
          told = [...missing]
          return roots.resolveAll(cwds, missing)
        }
      })
      // The resolver is told which cwds are gone, so it never walks them synchronously.
      expect(told).toEqual([gone])
      const byCwd = new Map(groups.map((g) => [g.cwd, g]))
      const pick = (cwd: string) => {
        const g = byCwd.get(cwd)!
        return { root: g.root, worktree: g.worktree, exists: g.exists }
      }
      // Grouping stays by exact cwd: the repo, its subdirectory and its worktree remain three groups.
      expect(groups).toHaveLength(4)
      expect(pick(repo)).toEqual({ root: repo, worktree: false, exists: true })
      expect(pick(sub)).toEqual({ root: repo, worktree: false, exists: true })
      expect(pick(wt)).toEqual({ root: repo, worktree: true, exists: true })
      expect(pick(gone)).toEqual({ root: gone, worktree: false, exists: false })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('reports existence fresh on every pass', async () => {
    const base = await realpath(await mkdtemp(path.join(TMP_BASE, 'indexer-exists-')))
    const root = path.join(base, 'claude')
    try {
      const repo = path.join(base, 'repo')
      const cwd = path.join(base, 'wt')
      await mkdir(path.join(repo, '.git'), { recursive: true })
      await mkdir(cwd)
      await writeFile(path.join(cwd, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`)
      await writeSession(root, '-wt', [msgLine('user', cwd, 'hello')], 1_000_000_000_000)
      const roots = new ProjectRoots({ home: path.join(base, 'home') })
      const resolveRoots = (cwds: readonly string[], missing: ReadonlySet<string>) => roots.resolveAll(cwds, missing)
      const cache = new Map()
      const first = await indexConversations(root, NO_CODEX, cache, { resolveRoots })
      expect(first.groups[0].exists).toBe(true)
      await rm(cwd, { recursive: true })
      const second = await indexConversations(root, NO_CODEX, cache, { resolveRoots })
      expect(second.groups[0].exists).toBe(false)
      // The project was resolved while the worktree existed; it must not revert to the bare cwd.
      expect(second.groups[0].root).toBe(repo)
      expect(second.groups[0].worktree).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('falls back to the cwd itself for a path that never existed', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-never-'))
    try {
      await writeSession(dir, '-home-user-project-one', [msgLine('user', CWD_A, 'hello')], 1_000_000_000_000)
      const { groups } = await indexConversations(dir, NO_CODEX)
      expect(groups.map((g) => ({ root: g.root, worktree: g.worktree, exists: g.exists }))).toEqual([
        { root: CWD_A, worktree: false, exists: false }
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("records each session file's creation time, for both agents", async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-birth-'))
    const codexRoot = path.join(dir, 'sessions')
    try {
      // An mtime in the FUTURE, so birth time cannot coincide with it: moving mtime earlier than
      // creation drags the reported birth time back with it on some filesystems.
      const later = Date.now() + 365 * 86_400_000
      const claude = await writeSession(dir, '-home-user-project-one', [msgLine('user', CWD_A, 'hi')], later)
      const codexId = await writeCodexRollout(codexRoot, CWD_B, 'user', later)
      const { groups } = await indexConversations(dir, codexRoot)
      const metas = groups.flatMap((g) => g.conversations)
      const codexFile = (await listCodexRollouts(codexRoot)).find((f) => f.includes(codexId))!
      const files = new Map([
        [claude.id, claude.file],
        [codexId, codexFile]
      ])
      expect(metas.map((m) => m.sessionId).sort()).toEqual([...files.keys()].sort())
      for (const meta of metas) {
        const { birthtimeMs } = await stat(files.get(meta.sessionId)!)
        expect(meta.birthtimeMs).not.toBe(meta.mtime)
        // A filesystem that does not report creation time yields 0, which must stay absent.
        expect(meta.birthtimeMs).toBe(birthtimeMs > 0 ? birthtimeMs : undefined)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('existenceProbe', () => {
  const never = new Promise<boolean>(() => {})

  it('answers by the deadline even when one check never settles', async () => {
    const probe = existenceProbe(async (cwd) => (cwd === '/hung' ? never : cwd === '/here'), 20)
    const started = Date.now()
    expect(await probe(['/here', '/gone', '/hung'])).toEqual(new Set(['/here']))
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('reuses a check still in flight instead of issuing another', async () => {
    const calls: string[] = []
    const probe = existenceProbe(async (cwd) => {
      calls.push(cwd)
      return cwd === '/hung' ? never : true
    }, 10)
    await probe(['/hung', '/ok'])
    await probe(['/hung', '/ok'])
    // The settled check runs again on the next pass; the hung one is joined, not repeated.
    expect(calls).toEqual(['/hung', '/ok', '/ok'])
  })

  it('never has more checks unsettled than its cap, across passes', async () => {
    const calls: string[] = []
    const probe = existenceProbe(async (cwd) => {
      calls.push(cwd)
      return never
    }, 10, 2)
    for (let i = 0; i < 5; i++) await probe(['/h1', '/h2', '/h3', '/h4'])
    // Two hung checks hold both slots for good; the other cwds are never checked while they do.
    expect(calls).toEqual(['/h1', '/h2'])
  })

  it('does not wait again on a check still pending from an earlier pass', async () => {
    // Joining a hung check each pass would cost every later pass the full deadline (and a handler).
    const probe = existenceProbe(async (cwd) => (cwd === '/hung' ? never : true), 300)
    await probe(['/hung', '/ok'])
    const started = Date.now()
    expect(await probe(['/hung', '/ok'])).toEqual(new Set(['/ok']))
    expect(Date.now() - started).toBeLessThan(150)
  })

  it('reports a cwd with no answer this pass by its last known answer', async () => {
    let calls = 0
    const probe = existenceProbe(async () => (++calls === 1 ? true : never), 10)
    expect(await probe(['/was-here'])).toEqual(new Set(['/was-here']))
    expect(await probe(['/was-here'])).toEqual(new Set(['/was-here']))
    expect(calls).toBe(2)
  })

  it('treats a failed check as missing', async () => {
    const probe = existenceProbe(async (cwd) => {
      if (cwd === '/err') throw new Error('EIO')
      return true
    }, 50)
    expect(await probe(['/err', '/ok'])).toEqual(new Set(['/ok']))
  })

  it('does not change a returned snapshot when a late check settles', async () => {
    let release: (v: boolean) => void = () => {}
    const late = new Promise<boolean>((r) => (release = r))
    const probe = existenceProbe(async (cwd) => (cwd === '/late' ? late : true), 10)
    const snapshot = await probe(['/late', '/ok'])
    release(true)
    await late
    await new Promise((r) => setTimeout(r, 0))
    expect(snapshot).toEqual(new Set(['/ok']))
  })

  it('never withholds the index behind a hung check', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-hung-'))
    try {
      await writeSession(dir, '-a', [msgLine('user', '/w/a', 'hello')], 1_000_000_000_000)
      await writeSession(dir, '-hung', [msgLine('user', '/w/hung', 'hello')], 1_000_000_001_000)
      const existing = existenceProbe(async (cwd) => (cwd === '/w/hung' ? never : true), 20)
      const { groups } = await indexConversations(dir, NO_CODEX, undefined, { existing })
      const byCwd = new Map(groups.map((g) => [g.cwd, g.exists]))
      expect(byCwd).toEqual(new Map([['/w/hung', false], ['/w/a', true]]))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('indexConversations resilience', () => {
  it('returns [] for a non-existent root (does not throw)', async () => {
    const missing = path.join(TMP_BASE, `does-not-exist-${randomUUID()}`)
    const { groups } = await indexConversations(missing, NO_CODEX)
    expect(groups).toEqual([])
  })

  it('returns [] when the root is a file, not a directory', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-file-root-'))
    const fileRoot = path.join(dir, 'a-file')
    await writeFile(fileRoot, 'not a dir', 'utf8')
    try {
      const { groups } = await indexConversations(fileRoot, NO_CODEX)
      expect(groups).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns [] for an empty projects root', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-empty-'))
    try {
      const { groups } = await indexConversations(dir, NO_CODEX)
      expect(groups).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('indexConversations meta cache', () => {
  it('reuses the cached meta object when a file is unchanged', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-cache-hit-'))
    try {
      await writeSession(
        dir,
        '-home-user-project-one',
        [msgLine('user', CWD_A, 'cached'), msgLine('assistant', CWD_A, 'reply')],
        1_000_000_000_000
      )
      const cache = new Map()
      const { groups: first } = await indexConversations(dir, NO_CODEX, cache)
      const { groups: second } = await indexConversations(dir, NO_CODEX, cache)
      const a1 = first.find((g) => g.cwd === CWD_A)!.conversations[0]
      const a2 = second.find((g) => g.cwd === CWD_A)!.conversations[0]
      expect(a2).toBe(a1) // same object reference => served from cache, not re-parsed
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('re-parses (new meta object) after a file changes', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-cache-miss-'))
    try {
      const r = await writeSession(
        dir,
        '-home-user-project-one',
        [msgLine('user', CWD_A, 'v1'), msgLine('assistant', CWD_A, 'reply')],
        1_000_000_000_000
      )
      const cache = new Map()
      const a1 = (await indexConversations(dir, NO_CODEX, cache)).groups.find((g) => g.cwd === CWD_A)!
        .conversations[0]
      // Append a turn + advance mtime so both size and mtime move (a real append does both).
      await writeFile(
        r.file,
        jsonl([
          msgLine('user', CWD_A, 'v1'),
          msgLine('assistant', CWD_A, 'reply'),
          msgLine('user', CWD_A, 'v2')
        ]),
        'utf8'
      )
      await utimes(r.file, 1_500_000, 1_500_000)
      const a2 = (await indexConversations(dir, NO_CODEX, cache)).groups.find((g) => g.cwd === CWD_A)!
        .conversations[0]
      expect(a2).not.toBe(a1) // (mtime, size) changed => re-parsed, new object
      expect(a2.sessionId).toBe(a1.sessionId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not reuse across calls when no cache is passed', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-cache-none-'))
    try {
      await writeSession(
        dir,
        '-home-user-project-one',
        [msgLine('user', CWD_A, 'x'), msgLine('assistant', CWD_A, 'y')],
        1_000_000_000_000
      )
      const a1 = (await indexConversations(dir, NO_CODEX)).groups.find((g) => g.cwd === CWD_A)!
        .conversations[0]
      const a2 = (await indexConversations(dir, NO_CODEX)).groups.find((g) => g.cwd === CWD_A)!
        .conversations[0]
      expect(a2).not.toBe(a1) // fresh throwaway cache each call => new object
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('indexConversations smoke (real ~/.claude/projects)', () => {
  const realRoot = path.join(homedir(), '.claude', 'projects')

  it('returns a well-formed index against the real projects dir, if present', async () => {
    let present = true
    try {
      await access(realRoot)
    } catch {
      present = false
    }
    if (!present) {
      // Nothing to assert in this environment; skip gracefully.
      expect(true).toBe(true)
      return
    }

    const { groups } = await indexConversations(realRoot, NO_CODEX)
    expect(Array.isArray(groups)).toBe(true)
    for (const group of groups) {
      expect(typeof group.cwd).toBe('string')
      expect(group.cwd.length).toBeGreaterThan(0)
      expect(group.conversations.length).toBeGreaterThan(0)
      expect(typeof group.latestMtime).toBe('number')
      expect(group.label.length).toBeGreaterThan(0)
      // Within-group ordering invariant.
      for (let i = 1; i < group.conversations.length; i++) {
        expect(group.conversations[i - 1].mtime).toBeGreaterThanOrEqual(
          group.conversations[i].mtime
        )
      }
    }
    // Between-group ordering invariant.
    for (let i = 1; i < groups.length; i++) {
      expect(groups[i - 1].latestMtime).toBeGreaterThanOrEqual(groups[i].latestMtime)
    }
  })
})
