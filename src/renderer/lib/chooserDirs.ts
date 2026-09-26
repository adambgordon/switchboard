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
export function chooserDirs(groups: readonly ConversationGroup[], preselect: string | null = null): string[] {
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
  return preselect === null || gone.has(preselect) ? dirs : [preselect, ...dirs.filter((d) => d !== preselect)]
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
