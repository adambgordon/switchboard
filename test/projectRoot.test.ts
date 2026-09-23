import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeRootFs, ProjectRoots, resolveProjectRoot } from '../src/main/sessions/projectRoot'

// Every tree is written by hand — `.git` directories and `gitdir:` files — rather than by running git,
// so each case pins exactly the on-disk shape it is about. Paths are realpath'd up front because the
// resolver canonicalizes (the system temp dir is commonly reached through a symlink).
let base: string
/** An injected home that none of the fixture trees live under, unless a case says otherwise. */
let home: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'project-root-test-')))
  home = path.join(base, 'home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

function dir(...segments: string[]): string {
  const p = path.join(base, ...segments)
  mkdirSync(p, { recursive: true })
  return p
}

/** A normal repository: `<p>/.git/` as a directory. */
function repo(...segments: string[]): string {
  const p = dir(...segments)
  mkdirSync(path.join(p, '.git'))
  return p
}

function gitFile(at: string, gitdir: string): void {
  writeFileSync(path.join(at, '.git'), `gitdir: ${gitdir}\n`)
}

describe('resolveProjectRoot', () => {
  it('resolves a repository to itself', () => {
    const r = repo('repo')
    expect(resolveProjectRoot(r, home)).toEqual({ root: r, worktree: false })
  })

  it('walks up from a subdirectory to the enclosing repository', () => {
    const r = repo('repo')
    const sub = dir('repo', 'src', 'deep')
    expect(resolveProjectRoot(sub, home)).toEqual({ root: r, worktree: false })
  })

  it('folds a linked worktree with an absolute gitdir into its main repository', () => {
    const r = repo('repo')
    dir('repo', '.git', 'worktrees', 'wt')
    const wt = dir('work', 'wt')
    gitFile(wt, path.join(r, '.git', 'worktrees', 'wt'))
    expect(resolveProjectRoot(wt, home)).toEqual({ root: r, worktree: true })
    expect(resolveProjectRoot(dir('work', 'wt', 'sub'), home)).toEqual({ root: r, worktree: true })
  })

  it('resolves a relative gitdir against the directory holding the .git file', () => {
    const r = repo('repo')
    dir('repo', '.git', 'worktrees', 'wt')
    // Relative to `<base>/work/wt`, NOT to the process cwd or to the subdirectory the walk began in.
    const wt = dir('work', 'wt')
    gitFile(wt, path.join('..', '..', 'repo', '.git', 'worktrees', 'wt'))
    expect(resolveProjectRoot(dir('work', 'wt', 'sub'), home)).toEqual({ root: r, worktree: true })
  })

  it('tolerates surrounding whitespace in the gitdir line', () => {
    const r = repo('repo')
    const wt = dir('work', 'wt')
    writeFileSync(path.join(wt, '.git'), `gitdir:   ${path.join(r, '.git', 'worktrees', 'wt')}  \r\n`)
    expect(resolveProjectRoot(wt, home)).toEqual({ root: r, worktree: true })
  })

  it('resolves a worktree of a bare repository to the bare repository itself', () => {
    const bare = dir('store', 'proj.git')
    dir('store', 'proj.git', 'worktrees', 'wt')
    const wt = dir('work', 'wt')
    gitFile(wt, path.join(bare, 'worktrees', 'wt'))
    // Not dirname(bare): a bare repository has no work tree around it, so its parent is unrelated.
    expect(resolveProjectRoot(wt, home)).toEqual({ root: bare, worktree: true })
  })

  it('treats a submodule as its own project, not as a worktree', () => {
    repo('super')
    dir('super', '.git', 'modules', 'sub')
    const sub = dir('super', 'sub')
    // A `.git` FILE, like a worktree's — only where its gitdir points tells the two apart.
    gitFile(sub, path.join('..', '.git', 'modules', 'sub'))
    expect(resolveProjectRoot(dir('super', 'sub', 'src'), home)).toEqual({ root: sub, worktree: false })
  })

  it('stops at the nearest repository when one is nested inside another', () => {
    repo('outer')
    const inner = repo('outer', 'vendor', 'inner')
    expect(resolveProjectRoot(dir('outer', 'vendor', 'inner', 'lib'), home)).toEqual({
      root: inner,
      worktree: false
    })
  })

  it('resolves a directory outside any repository to itself', () => {
    const plain = dir('scratch', 'notes')
    expect(resolveProjectRoot(plain, home)).toEqual({ root: plain, worktree: false })
  })

  it('follows a symlinked cwd to the real repository', () => {
    const r = repo('repo')
    const sub = dir('repo', 'src')
    const link = path.join(base, 'link')
    symlinkSync(sub, link)
    expect(resolveProjectRoot(link, home)).toEqual({ root: r, worktree: false })
  })

  it('never lets a repository at home claim a directory below it', () => {
    mkdirSync(path.join(home, '.git'))
    const under = dir('home', 'notes', 'today')
    expect(resolveProjectRoot(under, home)).toEqual({ root: under, worktree: false })
    // Home itself is still what it is.
    expect(resolveProjectRoot(home, home)).toEqual({ root: home, worktree: false })
  })

  it('recognizes home when it is given through a symlink', () => {
    mkdirSync(path.join(home, '.git'))
    const linkedHome = path.join(base, 'home-link')
    symlinkSync(home, linkedHome)
    const under = dir('home', 'notes')
    expect(resolveProjectRoot(under, linkedHome)).toEqual({ root: under, worktree: false })
  })

  it('still finds a real repository between home and the cwd', () => {
    mkdirSync(path.join(home, '.git'))
    const r = repo('home', 'code', 'repo')
    expect(resolveProjectRoot(dir('home', 'code', 'repo', 'src'), home)).toEqual({ root: r, worktree: false })
  })

  it('does not walk above home either', () => {
    // A repository enclosing home must not claim a directory under home: stopping at home stops
    // the whole walk, not just the test of home itself.
    const outer = repo('outer')
    const nestedHome = dir('outer', 'home')
    const under = dir('outer', 'home', 'notes')
    expect(resolveProjectRoot(under, nestedHome)).toEqual({ root: under, worktree: false })
    expect(resolveProjectRoot(dir('outer', 'elsewhere'), nestedHome)).toEqual({ root: outer, worktree: false })
  })

  it('returns null when the cwd no longer exists', () => {
    expect(resolveProjectRoot(path.join(base, 'gone'), home)).toBeNull()
  })
})

describe('ProjectRoots', () => {
  function cacheFile(dataDir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path.join(dataDir, 'project-roots.json'), 'utf8'))
  }

  /** A linked worktree of `repo`, returned with the repo so a case can delete the worktree. */
  function worktreeOf(): { repo: string; wt: string } {
    const r = repo('repo')
    const wt = dir('work', 'wt')
    gitFile(wt, path.join(r, '.git', 'worktrees', 'wt'))
    return { repo: r, wt }
  }

  it('keeps folding a deleted worktree into its repository from the persisted cache', () => {
    const data = dir('data')
    const { repo: r, wt } = worktreeOf()
    expect(new ProjectRoots({ dir: data, home }).resolve(wt)).toEqual({ root: r, worktree: true })
    rmSync(wt, { recursive: true })
    // A fresh launch: nothing memoized, and the path can no longer be walked.
    expect(new ProjectRoots({ dir: data, home }).resolve(wt)).toEqual({ root: r, worktree: true })
  })

  it('falls back to the cwd as given for a missing path it never saw', () => {
    const data = dir('data')
    const gone = path.join(base, 'never', 'existed')
    expect(new ProjectRoots({ dir: data, home }).resolve(gone)).toEqual({ root: gone, worktree: false })
  })

  it('round-trips the persisted cache across instances', () => {
    const data = dir('data')
    const { repo: r, wt } = worktreeOf()
    const plain = dir('scratch')
    new ProjectRoots({ dir: data, home }).resolveAll([wt, plain])
    expect(cacheFile(data)).toEqual({
      [wt]: { root: r, worktree: true },
      [plain]: { root: plain, worktree: false }
    })
    rmSync(wt, { recursive: true })
    rmSync(plain, { recursive: true })
    const reloaded = new ProjectRoots({ dir: data, home }).resolveAll([wt, plain])
    expect(reloaded.get(wt)).toEqual({ root: r, worktree: true })
    expect(reloaded.get(plain)).toEqual({ root: plain, worktree: false })
  })

  it('keeps entries another process wrote since this one loaded the cache', () => {
    // Two processes sharing one userData directory both start from an empty cache, then each learns
    // a different worktree. The second write must not erase the first process's entry.
    const data = dir('data')
    const r = repo('repo')
    const wtA = dir('work', 'a')
    const wtB = dir('work', 'b')
    gitFile(wtA, path.join(r, '.git', 'worktrees', 'a'))
    gitFile(wtB, path.join(r, '.git', 'worktrees', 'b'))
    const first = new ProjectRoots({ dir: data, home })
    const second = new ProjectRoots({ dir: data, home })
    first.resolve(wtA)
    second.resolve(wtB)
    expect(cacheFile(data)).toEqual({
      [wtA]: { root: r, worktree: true },
      [wtB]: { root: r, worktree: true }
    })
    rmSync(wtA, { recursive: true })
    expect(new ProjectRoots({ dir: data, home }).resolve(wtA)).toEqual({ root: r, worktree: true })
  })

  it('does not revert an entry another process has since re-resolved', () => {
    // This process learned x under the old repository. The worktree is then re-pointed and a fresh
    // process records x under the new one. This process saving an UNRELATED entry must not put its
    // stale view of x back.
    const data = dir('data')
    const oldRepo = repo('old')
    const newRepo = repo('new')
    const x = dir('work', 'x')
    gitFile(x, path.join(oldRepo, '.git', 'worktrees', 'x'))
    const stale = new ProjectRoots({ dir: data, home })
    stale.resolve(x)
    gitFile(x, path.join(newRepo, '.git', 'worktrees', 'x'))
    new ProjectRoots({ dir: data, home }).resolve(x)
    stale.resolve(dir('work', 'y'))
    expect(cacheFile(data)[x]).toEqual({ root: newRepo, worktree: true })
  })

  it('keeps a change that failed to write and writes it with the next one', () => {
    const data = path.join(base, 'data-later')
    const roots = new ProjectRoots({ dir: data, home })
    const a = repo('a')
    roots.resolve(a)
    mkdirSync(data)
    const b = repo('b')
    roots.resolve(b)
    expect(Object.keys(cacheFile(data)).sort()).toEqual([a, b].sort())
  })

  it('skips the walk for a cwd the caller knows is missing and answers from the cache', () => {
    const data = dir('data')
    const { repo: r, wt } = worktreeOf()
    new ProjectRoots({ dir: data, home }).resolve(wt)
    let walks = 0
    const counting = { ...nodeRootFs, realpath: (p: string) => (walks++, nodeRootFs.realpath(p)) }
    const roots = new ProjectRoots({ dir: data, home, fs: counting })
    expect(roots.resolveAll([wt], new Set([wt])).get(wt)).toEqual({ root: r, worktree: true })
    expect(walks).toBe(0)
  })

  it('tolerates a corrupt cache file', () => {
    const data = dir('data')
    writeFileSync(path.join(data, 'project-roots.json'), '{not json')
    const r = repo('repo')
    const roots = new ProjectRoots({ dir: data, home })
    expect(roots.resolve(r)).toEqual({ root: r, worktree: false })
    // ...and replaces it with a valid one.
    expect(cacheFile(data)).toEqual({ [r]: { root: r, worktree: false } })
  })

  it('drops malformed cache entries and keeps the valid ones', () => {
    const data = dir('data')
    const gone = path.join(base, 'gone')
    const alsoGone = path.join(base, 'also-gone')
    writeFileSync(
      path.join(data, 'project-roots.json'),
      JSON.stringify({ [gone]: { root: '/r', worktree: 'yes' }, [alsoGone]: { root: '/r', worktree: true } })
    )
    const roots = new ProjectRoots({ dir: data, home })
    expect(roots.resolve(gone)).toEqual({ root: gone, worktree: false })
    expect(roots.resolve(alsoGone)).toEqual({ root: '/r', worktree: true })
  })

  it('tolerates a cache file whose top level is not an object', () => {
    const data = dir('data')
    const gone = path.join(base, 'gone')
    for (const top of [null, [{ root: '/r', worktree: true }], 'text', 7]) {
      writeFileSync(path.join(data, 'project-roots.json'), JSON.stringify(top))
      expect(new ProjectRoots({ dir: data, home }).resolve(gone)).toEqual({ root: gone, worktree: false })
    }
  })

  it('prefers a fresh resolution over the cache and rewrites the stale entry', () => {
    const data = dir('data')
    const r = repo('repo')
    const sub = dir('repo', 'sub')
    writeFileSync(
      path.join(data, 'project-roots.json'),
      JSON.stringify({ [sub]: { root: '/somewhere/else', worktree: true } })
    )
    expect(new ProjectRoots({ dir: data, home }).resolve(sub)).toEqual({ root: r, worktree: false })
    expect(cacheFile(data)).toEqual({ [sub]: { root: r, worktree: false } })
  })

  it('memoizes a resolution for the rest of the launch', () => {
    const parent = dir('scratch')
    const sub = dir('scratch', 'sub')
    const roots = new ProjectRoots({ home })
    expect(roots.resolve(sub)).toEqual({ root: sub, worktree: false })
    // The parent becomes a repository mid-launch. A fresh walk would now answer `parent`.
    mkdirSync(path.join(parent, '.git'))
    expect(roots.resolve(sub)).toEqual({ root: sub, worktree: false })
    expect(new ProjectRoots({ home }).resolve(sub)).toEqual({ root: parent, worktree: false })
  })

  it('writes the cache once per batch, not once per cwd', () => {
    const data = dir('data')
    const cwds = [repo('a'), repo('b'), repo('c')]
    let writes = 0
    const roots = new ProjectRoots({ dir: data, home })
    const save = (roots as unknown as { save: () => void }).save.bind(roots)
    ;(roots as unknown as { save: () => void }).save = () => {
      writes++
      save()
    }
    roots.resolveAll(cwds)
    expect(writes).toBe(1)
    // Nothing new: an all-memoized batch does not write at all.
    roots.resolveAll(cwds)
    expect(writes).toBe(1)
    expect(Object.keys(cacheFile(data)).sort()).toEqual([...cwds].sort())
  })

  it('never throws when the cache directory is unwritable', () => {
    const r = repo('repo')
    const roots = new ProjectRoots({ dir: path.join(base, 'no-such-dir'), home })
    expect(roots.resolve(r)).toEqual({ root: r, worktree: false })
  })
})
