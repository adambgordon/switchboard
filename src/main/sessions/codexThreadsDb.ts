/**
 * Reading Codex conversation titles from Codex's own index DB.
 *
 * A Codex rename (codexRename.ts) writes `threads.title` in `~/.codex/state_*.sqlite`, NOT the
 * rollout — so the rollout-derived title (codexParser's `cleanTitle(firstUser)`) never reflects it.
 * This module reads that table so the indexer can prefer Codex's own title (auto-derived for
 * un-renamed sessions, the custom name once renamed), keeping Switchboard's display in sync with
 * what Codex itself shows.
 *
 * `state_N.sqlite` is WAL-mode; `node:sqlite` opened read-only honors the `-wal` (verified), so a
 * fresh rename is visible immediately even before a checkpoint. The filename is versioned, so we glob
 * `state_*.sqlite` and pick the newest. Every failure mode (missing DB, schema drift, lock) degrades
 * to an empty map — the title read must never crash the index.
 *
 * Pure Node — no Electron, no DOM. Synchronous (node:sqlite is sync; the `threads` table is tiny).
 */

import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default Codex home: `~/.codex` (parent of the sessions root). */
export function defaultCodexHome(): string {
  return path.join(homedir(), '.codex')
}

/** Newest `state_<N>.sqlite` under `home` (highest N), or null when none / unreadable. */
function newestStateDb(home: string): string | null {
  let best: { n: number; file: string } | null = null
  let entries: string[]
  try {
    entries = readdirSync(home)
  } catch {
    return null
  }
  for (const name of entries) {
    const m = name.match(/^state_(\d+)\.sqlite$/)
    if (!m) continue
    const n = Number(m[1])
    if (!best || n > best.n) best = { n, file: name }
  }
  return best ? path.join(home, best.file) : null
}

/**
 * Map of Codex sessionId (== threadId) -> title, read from the newest `state_*.sqlite`. Only
 * non-empty titles are included; absent/empty entries leave the caller on its rollout-derived
 * fallback. Returns an empty map on any failure.
 */
export function readCodexTitles(home: string = defaultCodexHome()): Map<string, string> {
  const titles = new Map<string, string>()
  const dbPath = newestStateDb(home)
  if (!dbPath) return titles

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT id, title FROM threads').all() as Array<Record<string, unknown>>
    for (const row of rows) {
      const id = row.id
      const title = row.title
      if (typeof id === 'string' && typeof title === 'string' && title.trim().length > 0) {
        titles.set(id, title)
      }
    }
  } catch {
    return titles
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
  return titles
}
