/**
 * One-time tasks: things the app does exactly once per profile, ever — not once per launch, and not
 * once per window. Pure, so it is unit-tested; the caller reads and writes the store.
 *
 * The store is the list of task ids already done, shared by every window. A task is marked done by
 * folding its id into a FRESH read, so two windows finishing different tasks cannot erase each other.
 */
export const ONCE_TASKS_KEY = 'switchboard.once'

/** The rail's folder order frozen newest-first, the first time a profile runs this rail. */
export const FOLDER_SEED_TASK = 'folderSeed'

/** What's new, one id per release that added to it, oldest first: tabs, the compact and folder sidebar
 *  and the bell; then hiding and filtering. A later release takes a new id, so it shows once too; a
 *  release that adds nothing to the dialog adds no id. */
export const WHATS_NEW_RELEASES = ['whatsNew:1', 'whatsNew:2'] as const
export type WhatsNewRelease = (typeof WHATS_NEW_RELEASES)[number]

/** The releases `done` has not seen yet, newest first — the order the dialog shows them in. */
export function unseenWhatsNew(done: readonly string[]): WhatsNewRelease[] {
  return WHATS_NEW_RELEASES.filter((r) => !done.includes(r)).reverse()
}

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
