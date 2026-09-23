/**
 * Resolve which project a working directory belongs to, so the rail can fold every conversation
 * started anywhere inside one repository — its subdirectories and its linked worktrees — under a
 * single project.
 *
 * Synchronous on purpose: `PtyManager.spawn` is synchronous and the `PtySession` it announces must
 * carry `projectRoot` on its very first broadcast. Resolution costs a handful of syscalls per
 * directory level and {@link ProjectRoots} memoizes it, so it runs once per distinct cwd per app
 * launch — not once per index pass.
 *
 * Electron-free (the persistence dir is injected) so it stays unit-testable under the node tsconfig.
 */

import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export interface ProjectRoot {
  /** The project directory: a repository's work tree, or the cwd itself outside any repository. */
  root: string
  /** True when the cwd sits in a linked worktree, so `root` is a different checkout of the repo. */
  worktree: boolean
}

/** The filesystem reads resolution needs, injected so tests can observe or fake them. */
export interface RootFs {
  /** Canonical path; throws when `p` does not exist. */
  realpath(p: string): string
  /** What `p` is, following symlinks; null when it is missing or unreadable. */
  kind(p: string): 'dir' | 'file' | null
  /** Contents as UTF-8; throws on failure. */
  readFile(p: string): string
}

export const nodeRootFs: RootFs = {
  realpath: (p) => realpathSync(p),
  kind: (p) => {
    try {
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) return null
      if (st.isDirectory()) return 'dir'
      return st.isFile() ? 'file' : null
    } catch {
      return null
    }
  },
  readFile: (p) => readFileSync(p, 'utf8')
}

function tryRealpath(fs: RootFs, p: string): string | null {
  try {
    return fs.realpath(p)
  } catch {
    return null
  }
}

/**
 * Interpret a `.git` FILE found in `dir`. Git writes one in two situations that must be told apart:
 * a linked worktree (`gitdir: <common>/worktrees/<name>`), which belongs to the repository owning
 * `<common>`, and a submodule (`gitdir: <super>/.git/modules/<name>`), which is a project of its own.
 * Anything unparseable still marks a repository boundary, so it too resolves to `dir`.
 */
function resolveGitFile(fs: RootFs, dir: string, gitFile: string): ProjectRoot {
  let content: string
  try {
    content = fs.readFile(gitFile)
  } catch {
    return { root: dir, worktree: false }
  }
  const match = /^gitdir:\s*(.+)$/m.exec(content)
  if (!match) return { root: dir, worktree: false }
  // Git records a relative gitdir relative to the directory holding the `.git` file. Trailing
  // whitespace needs no trimming: it can only reach the last segment, the worktree's name, and the
  // project is read from the segments above it.
  const gitdir = path.resolve(dir, match[1])
  if (path.basename(path.dirname(gitdir)) !== 'worktrees') return { root: dir, worktree: false }
  const common = path.dirname(path.dirname(gitdir))
  // A normal repository keeps its common dir at `<repo>/.git`, so the project is the directory
  // around it; a bare repository IS its common dir (e.g. `proj.git`), which has no work tree of its
  // own to point at.
  const root = path.basename(common) === '.git' ? path.dirname(common) : common
  return { root: tryRealpath(fs, root) ?? root, worktree: true }
}

/**
 * Walk up from `cwd` to the nearest enclosing repository and return its project root, or the cwd
 * itself when there is none. Returns null when `cwd` no longer exists — only the caller can know
 * where a vanished directory used to belong.
 *
 * The walk never tests `home` on behalf of a directory below it: a repository at the home
 * directory is a dotfiles checkout, not a project, and would otherwise swallow every non-repo
 * directory under home into one folder. `home` itself still resolves normally.
 */
export function resolveProjectRoot(cwd: string, home: string, fs: RootFs = nodeRootFs): ProjectRoot | null {
  const start = tryRealpath(fs, cwd)
  if (start == null) return null
  const realHome = tryRealpath(fs, home) ?? path.resolve(home)
  let dir = start
  while (true) {
    if (dir === realHome && start !== realHome) break
    const gitPath = path.join(dir, '.git')
    const kind = fs.kind(gitPath)
    if (kind === 'dir') return { root: dir, worktree: false }
    if (kind === 'file') return resolveGitFile(fs, dir, gitPath)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { root: start, worktree: false }
}

const FILE = 'project-roots.json'

function isProjectRoot(v: unknown): v is ProjectRoot {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.root === 'string' && r.root.length > 0 && typeof r.worktree === 'boolean'
}

/** Read `<dir>/project-roots.json`; missing, corrupt, or malformed entries are dropped, never fatal. */
function loadPersisted(dir: string): Map<string, ProjectRoot> {
  const out = new Map<string, ProjectRoot>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path.join(dir, FILE), 'utf8'))
  } catch {
    return out
  }
  // Only null needs refusing: `Object.entries` yields nothing usable from any other non-object, and
  // an array's entries are rejected by the shape check below.
  if (typeof parsed !== 'object' || parsed === null) return out
  for (const [cwd, value] of Object.entries(parsed)) {
    if (isProjectRoot(value)) out.set(cwd, { root: value.root, worktree: value.worktree })
  }
  return out
}

export interface ProjectRootsOptions {
  /** Directory holding the persisted cache (the app's userData). Omit for no persistence. */
  dir?: string
  /** The home directory the walk must not enter from below. Defaults to the real one. */
  home?: string
  fs?: RootFs
}

/**
 * Per-launch project-root resolution with a persisted fallback.
 *
 * A cwd is resolved fresh the first time it is seen in a launch and then memoized, so a repository
 * created or removed mid-launch is picked up at the next launch. The persisted cache is consulted
 * ONLY for a cwd that no longer exists: a worktree deleted from disk keeps folding into the repo it
 * belonged to, which a fresh walk can no longer discover. A missing cwd is not memoized, so a
 * directory that reappears is resolved fresh again.
 */
export class ProjectRoots {
  private readonly memo = new Map<string, ProjectRoot>()
  private readonly persisted: Map<string, ProjectRoot>
  private readonly dir: string | null
  private readonly home: string
  private readonly fs: RootFs

  constructor(opts: ProjectRootsOptions = {}) {
    this.dir = opts.dir ?? null
    this.home = opts.home ?? homedir()
    this.fs = opts.fs ?? nodeRootFs
    this.persisted = this.dir ? loadPersisted(this.dir) : new Map()
  }

  /** Resolve one cwd. Sync; memo → fresh walk → persisted cache → the cwd itself. */
  resolve(cwd: string): ProjectRoot {
    return this.resolveAll([cwd]).get(cwd) ?? { root: cwd, worktree: false }
  }

  /**
   * Resolve a batch of cwds, writing the persisted cache at most once for the whole batch — an
   * index pass resolves every group together, and the first pass of a launch can be all fresh.
   */
  resolveAll(cwds: Iterable<string>): Map<string, ProjectRoot> {
    const out = new Map<string, ProjectRoot>()
    let changed = false
    for (const cwd of cwds) {
      if (out.has(cwd)) continue
      const memoized = this.memo.get(cwd)
      if (memoized) {
        out.set(cwd, memoized)
        continue
      }
      const fresh = resolveProjectRoot(cwd, this.home, this.fs)
      if (fresh) {
        this.memo.set(cwd, fresh)
        out.set(cwd, fresh)
        const prior = this.persisted.get(cwd)
        if (!prior || prior.root !== fresh.root || prior.worktree !== fresh.worktree) {
          this.persisted.set(cwd, fresh)
          changed = true
        }
        continue
      }
      // A cwd that no longer exists: its fallback is the cwd as given, since a vanished path has no
      // realpath to canonicalize it to.
      out.set(cwd, this.persisted.get(cwd) ?? { root: cwd, worktree: false })
    }
    if (changed) this.save()
    return out
  }

  /** Persist the cache. Best-effort — losing it only costs the folding of since-deleted worktrees. */
  private save(): void {
    if (!this.dir) return
    const obj: Record<string, ProjectRoot> = {}
    for (const [cwd, entry] of this.persisted) obj[cwd] = entry
    try {
      writeFileSync(path.join(this.dir, FILE), JSON.stringify(obj))
    } catch {
      /* a lost cache only costs deleted worktrees their folding; not worth surfacing */
    }
  }
}
