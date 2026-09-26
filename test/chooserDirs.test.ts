import { describe, expect, it } from 'vitest'
import type { ConversationGroup, ConversationMeta } from '../src/shared/types'
import { chooserDirs, chooserPreselect } from '../src/renderer/lib/chooserDirs'
import { buildSidebar, DEFAULT_SIDEBAR_LIMITS } from '../src/renderer/lib/sidebarModel'

const T = 1_780_000_000_000

function conv(sessionId: string, start: number | null, cwd: string): ConversationMeta {
  return {
    sessionId,
    agent: 'claude',
    cwd,
    title: sessionId,
    preview: '',
    gitBranch: null,
    mtime: T,
    messageCount: 1,
    version: null,
    sizeBytes: 0,
    model: null,
    outputTokens: 0,
    inputTokens: 0,
    contextTokens: 0,
    firstActivityAt: start
  }
}

function group(
  cwd: string,
  starts: (number | null)[],
  over: Partial<Pick<ConversationGroup, 'root' | 'worktree' | 'exists' | 'rootExists'>> = {}
): ConversationGroup {
  return {
    cwd,
    root: cwd,
    worktree: false,
    exists: true,
    rootExists: true,
    label: cwd,
    conversations: starts.map((s, i) => conv(`${cwd}#${i}`, s, cwd)),
    latestMtime: 0,
    ...over
  }
}

const worktree = (cwd: string, root: string, starts: number[], exists = true): ConversationGroup =>
  group(cwd, starts, { root, worktree: true, exists })

describe('chooserDirs', () => {
  it('ranks folders by their newest conversation start, not by input order', () => {
    // /w/busy's newest start sits mid-list, and its starts sum past /w/new's: ranking by the first or
    // last conversation, or by a total, each order these differently.
    const groups = [group('/w/busy', [T + 1, T + 4, T + 2]), group('/w/new', [T + 5]), group('/w/old', [T + 3])]
    expect(chooserDirs(groups)).toEqual(['/w/new', '/w/busy', '/w/old'])
  })

  it('sinks a folder whose conversations were never typed in', () => {
    const groups = [group('/w/empty', [null]), group('/w/used', [T])]
    expect(chooserDirs(groups)).toEqual(['/w/used', '/w/empty'])
  })

  it('lists a repo used only through a worktree once, as its root', () => {
    expect(chooserDirs([worktree('/w/wt/feature', '/w/repo', [T])])).toEqual(['/w/repo'])
  })

  it('collapses worktrees of one repo into one entry ranked by the newest', () => {
    // The newest worktree is neither first nor last, and the three sum past /w/new: taking the first
    // or last absorbed start, or a total, each rank the repo differently.
    const groups = [
      worktree('/w/wt/a', '/w/repo', [T + 1]),
      group('/w/new', [T + 5]),
      worktree('/w/wt/b', '/w/repo', [T + 4]),
      group('/w/old', [T + 3]),
      worktree('/w/wt/c', '/w/repo', [T + 2])
    ]
    expect(chooserDirs(groups)).toEqual(['/w/new', '/w/repo', '/w/old'])
  })

  it('keeps a subdirectory of a repo as itself', () => {
    expect(chooserDirs([group('/w/repo/src', [T], { root: '/w/repo' })])).toEqual(['/w/repo/src'])
  })

  it('omits a directory that no longer exists', () => {
    const groups = [group('/w/gone', [T + 9], { exists: false }), group('/w/here', [T])]
    expect(chooserDirs(groups)).toEqual(['/w/here'])
  })

  it('never folds a worktree back onto a root the index reports gone', () => {
    const groups = [
      group('/w/repo', [T + 1], { exists: false }),
      worktree('/w/wt/cached', '/w/repo', [T + 9], false),
      group('/w/here', [T + 3])
    ]
    expect(chooserDirs(groups)).toEqual(['/w/here'])
    expect(chooserDirs(groups, '/w/repo')).toEqual(['/w/here'])
  })

  it('drops a repo used only through worktrees once the repo itself is gone', () => {
    // Nothing runs in /w/repo directly, so only the root check knows it is gone. The live worktree
    // beside it keeps its own repo.
    const groups = [
      worktree('/w/wt/old', '/w/repo', [T + 9], false),
      group('/w/wt/live', [T + 5], { root: '/w/other', worktree: true }),
      group('/w/here', [T + 1])
    ]
    groups[0].rootExists = false
    expect(chooserDirs(groups)).toEqual(['/w/other', '/w/here'])
    expect(chooserDirs(groups, '/w/repo')).toEqual(['/w/other', '/w/here'])
  })

  it('still lists the repo of a worktree that was removed', () => {
    expect(chooserDirs([worktree('/w/wt/removed', '/w/repo', [T], false)])).toEqual(['/w/repo'])
  })

  it('pins the preselected folder to the top without listing it twice', () => {
    const groups = [group('/w/a', [T + 9]), group('/w/b', [T + 5]), group('/w/c', [T + 1])]
    expect(chooserDirs(groups, '/w/b')).toEqual(['/w/b', '/w/a', '/w/c'])
  })

  it('does not pin back a preselect the index reports gone', () => {
    // A deleted directory outside any repository is its own root, so the preselect's fallback lands
    // on the same missing path. A live folder beside it must still pin, whatever else is gone.
    const groups = [group('/w/gone', [T + 9], { exists: false }), group('/w/here', [T + 1]), group('/w/new', [T + 5])]
    expect(chooserDirs(groups, chooserPreselect(groups, '/w/gone', '/w/gone'))).toEqual(['/w/new', '/w/here'])
    expect(chooserDirs(groups, '/w/here')).toEqual(['/w/here', '/w/new'])
  })

  it('pins a preselected folder the list would not otherwise offer', () => {
    expect(chooserDirs([group('/w/a', [T])], '/w/wt/live')).toEqual(['/w/wt/live', '/w/a'])
  })
})

describe('the rail is unaffected', () => {
  it('keeps a missing directory in the sidebar model while the chooser omits it', () => {
    const groups = [group('/w/gone', [T], { exists: false })]
    expect(chooserDirs(groups)).toEqual([])
    const model = buildSidebar({
      mode: 'folders',
      groups,
      ptys: [],
      pinned: [],
      hidden: new Set(),
      rowRanks: {},
      folderRanks: {},
      liveState: () => null,
      active: new Set(),
      collapsed: {},
      navExpanded: new Set(),
      activeCollapsed: new Set(),
      revealed: {},
      search: null,
      limits: DEFAULT_SIDEBAR_LIMITS
    })
    expect(model.groups.map((g) => g.key)).toEqual(['/w/gone'])
  })
})

describe('chooserPreselect', () => {
  it('preselects the directory the conversation runs in while it exists, a worktree included', () => {
    const groups = [worktree('/w/wt/live', '/w/repo', [T])]
    expect(chooserPreselect(groups, '/w/wt/live', '/w/repo')).toBe('/w/wt/live')
  })

  it('falls back to the project root once that directory is gone', () => {
    const groups = [worktree('/w/wt/removed', '/w/repo', [T], false)]
    expect(chooserPreselect(groups, '/w/wt/removed', '/w/repo')).toBe('/w/repo')
  })

  it('keeps the directory of a live terminal the index has not seen yet', () => {
    expect(chooserPreselect([group('/w/other', [T])], '/w/wt/fresh', '/w/repo')).toBe('/w/wt/fresh')
  })

  it('judges existence by the directory itself, not by another folder that is gone', () => {
    const groups = [group('/w/gone', [T], { exists: false }), worktree('/w/wt/live', '/w/repo', [T])]
    expect(chooserPreselect(groups, '/w/wt/live', '/w/repo')).toBe('/w/wt/live')
  })
})
