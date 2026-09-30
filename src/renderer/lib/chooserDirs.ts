import type { ConversationGroup } from '@shared/types'

/**
 * The folders the new-conversation chooser offers, newest-started first, with `preselect` (when given)
 * pinned to the top.
 *
 * The chooser is for picking a project, so a linked worktree — branch-scoped and short-lived — is
 * listed as its repository, ranked by the newest of the worktrees it absorbs. That holds even when the
 * worktree itself is gone: a repo you only ever used through since-removed worktrees still appears. A
 * directory that no longer exists is left out, since nothing can start in it. Subdirectories stay
 * listed as themselves: "start in `repo/src`" is a real choice.
 *
 * Ranked by when each folder's newest conversation STARTED, not by last activity: "where was I last?"
 * and "where am I likely to start something new?" are different questions. `firstActivityAt` is the
 * first real message, so a session opened but never typed in scores 0 — an empty session is not
 * evidence you work there.
 *
 * "Gone" is judged once, on the final list: a directory the index reports missing — a group's cwd, or
 * a group's root — is never offered, however it got there: directly, as the root a worktree folds
 * into, or as the preselect. A directory the index says nothing about is unknown and stays: the
 * chooser cannot tell it from a live terminal's new directory.
 */
export function chooserDirs(groups: readonly ConversationGroup[], preselect: string | null = null): ChooserFolder[] {
  const gone = new Set<string>()
  for (const g of groups) {
    if (!g.exists) gone.add(g.cwd)
    if (!g.rootExists) gone.add(g.root)
  }
  const started = new Map<string, number>()
  for (const g of groups) {
    const dir = g.worktree ? g.root : g.cwd
    const at = g.conversations.reduce((max, c) => Math.max(max, c.firstActivityAt ?? 0), 0)
    started.set(dir, Math.max(started.get(dir) ?? 0, at))
  }
  const dirs = [...started.keys()].filter((d) => !gone.has(d)).sort((a, b) => started.get(b)! - started.get(a)!)
  const ordered =
    preselect === null || gone.has(preselect) ? dirs : [preselect, ...dirs.filter((d) => d !== preselect)]
  return ordered.map((dir) => ({ dir, startedAt: started.get(dir) ?? 0 }))
}

/** One folder the chooser offers, with when its newest conversation started (0: never, or unknown). */
export interface ChooserFolder {
  dir: string
  startedAt: number
}

/**
 * The folders matching a typed filter, in the order given. Every whitespace-separated word must appear in
 * the path, case-insensitively — so "exp at" finds `…/atlas/billing-export` — and the ranking stays
 * the chooser's own, since a filter narrows the list rather than re-deciding what is likely.
 */
export function filterChooserFolders(folders: readonly ChooserFolder[], query: string): readonly ChooserFolder[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return folders
  return folders.filter((f) => {
    const path = f.dir.toLowerCase()
    return words.every((w) => path.includes(w))
  })
}

/**
 * The folder to preselect for "a new conversation where I am": the directory the conversation runs
 * in — a live worktree included, since that is where the work is — unless the index reports it gone,
 * then its project root. A directory the index has no group for is kept: that is a live terminal whose
 * conversation has no messages yet, running in a directory that existed when it started.
 */
export function chooserPreselect(groups: readonly ConversationGroup[], cwd: string, root: string): string {
  return groups.some((g) => g.cwd === cwd && !g.exists) ? root : cwd
}
