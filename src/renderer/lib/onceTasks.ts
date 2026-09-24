/**
 * One-time tasks: things the app does exactly once per profile, ever — not once per launch, and not
 * once per window. Pure, so it is unit-tested; the caller reads and writes the store.
 *
 * The store is the list of task ids already done, shared by every window. A task is marked done by
 * folding its id into a FRESH read, so two windows finishing different tasks cannot erase each other.
 */
export const ONCE_TASKS_KEY = 'switchboard.once'

/** The rail's folder order frozen newest-first, the first time a profile runs the new rail. */
export const FOLDER_SEED_TASK = 'folderSeed'

export function parseOnceTasks(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** `done` with `task` added. Returns `done` itself when it is already there. */
export function withOnceTask(done: readonly string[], task: string): readonly string[] {
  return done.includes(task) ? done : [...done, task]
}
