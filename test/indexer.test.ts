import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { indexConversations } from '../src/main/sessions/indexer'

/** Base for test temp dirs; honors CLAUDE_CODE_TMPDIR if set, else the system temp. */
const TMP_BASE = process.env.CLAUDE_CODE_TMPDIR ?? tmpdir()

/** A nonexistent Codex sessions root, so these Claude-focused tests stay hermetic — the indexer now
 *  also scans `~/.codex/sessions` by default, which would otherwise leak the real machine's Codex
 *  conversations into these assertions. */
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
    gitBranch: 'develop',
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
    const groups = await indexConversations(root, NO_CODEX)
    const byCwd = new Map(groups.map((g) => [g.cwd, g]))

    expect(byCwd.has(CWD_A)).toBe(true)
    expect(byCwd.has(CWD_B)).toBe(true)
    expect(byCwd.get(CWD_A)!.conversations).toHaveLength(2)
    expect(byCwd.get(CWD_B)!.conversations).toHaveLength(1)
  })

  it('drops 0-message conversations', async () => {
    const groups = await indexConversations(root, NO_CODEX)
    const a = groups.find((g) => g.cwd === CWD_A)!
    const ids = a.conversations.map((c) => c.sessionId)
    expect(ids).toContain(aOld)
    expect(ids).toContain(aNew)
    expect(ids).toHaveLength(2) // the empty file is not present
  })

  it('sorts conversations within a group by mtime desc', async () => {
    const groups = await indexConversations(root, NO_CODEX)
    const a = groups.find((g) => g.cwd === CWD_A)!
    expect(a.conversations.map((c) => c.sessionId)).toEqual([aNew, aOld])
    expect(a.conversations[0].mtime).toBeGreaterThan(a.conversations[1].mtime)
  })

  it('sets label to the basename of the cwd', async () => {
    const groups = await indexConversations(root, NO_CODEX)
    expect(groups.find((g) => g.cwd === CWD_A)!.label).toBe('project-one')
    expect(groups.find((g) => g.cwd === CWD_B)!.label).toBe('project-two')
  })

  it('sets latestMtime per group and sorts groups by latestMtime desc', async () => {
    const groups = await indexConversations(root, NO_CODEX)
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
    const groups = await indexConversations(root, NO_CODEX)
    const b = groups.find((g) => g.cwd === CWD_B)!
    expect(b.conversations.map((c) => c.sessionId)).toEqual([bOnly])
  })
})

describe('indexConversations background-job filtering', () => {
  let root: string
  let interactive: string

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

    // A background-job session in the SAME cwd (top-level sessionKind:'bg') — must be DROPPED,
    // even though it has messages and a later mtime.
    await writeSession(
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
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('drops sessionKind:"bg" sessions but keeps the interactive sibling', async () => {
    const groups = await indexConversations(root, NO_CODEX)
    const a = groups.find((g) => g.cwd === CWD_A)
    expect(a).toBeDefined()
    const ids = a!.conversations.map((c) => c.sessionId)
    expect(ids).toEqual([interactive]) // the bg session is absent
  })
})

describe('indexConversations resilience', () => {
  it('returns [] for a non-existent root (does not throw)', async () => {
    const missing = path.join(TMP_BASE, `does-not-exist-${randomUUID()}`)
    const groups = await indexConversations(missing, NO_CODEX)
    expect(groups).toEqual([])
  })

  it('returns [] when the root is a file, not a directory', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-file-root-'))
    const fileRoot = path.join(dir, 'a-file')
    await writeFile(fileRoot, 'not a dir', 'utf8')
    try {
      const groups = await indexConversations(fileRoot, NO_CODEX)
      expect(groups).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns [] for an empty projects root', async () => {
    const dir = await mkdtemp(path.join(TMP_BASE, 'indexer-empty-'))
    try {
      const groups = await indexConversations(dir, NO_CODEX)
      expect(groups).toEqual([])
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

    const groups = await indexConversations(realRoot, NO_CODEX)
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
