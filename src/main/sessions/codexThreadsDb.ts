/**
 * Reading Codex conversation metadata (title + archived) from Codex's own index DB.
 *
 * A Codex rename (codexRename.ts) writes `threads.title` in `~/.codex/state_*.sqlite`, NOT the
 * rollout — so the rollout-derived title (codexParser's `cleanTitle(firstUser)`) never reflects it.
 * This module reads that table so the indexer can prefer Codex's own title (auto-derived for
 * un-renamed sessions, the custom name once renamed), keeping Switchboard's display in sync with
 * what Codex itself shows.
 *
 * `state_N.sqlite` is WAL-mode; `node:sqlite` opened read-only honors the `-wal` (verified), so a
 * fresh rename is visible immediately even before a checkpoint. The filename is versioned, so we glob
 * `state_*.sqlite` and pick the newest. Every failure mode degrades to an empty map — the read must
 * never crash the index — including a readonly-open race: while Codex is actively writing, a
 * read-only open can transiently fail (`SQLITE_CANTOPEN`); the next pass picks it up.
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

/** A Codex thread's index-DB row (the bits Switchboard needs). */
export interface CodexThreadRow {
  /** The session's title (auto-derived from the first message, or the renamed value); '' when absent. */
  title: string
  /** The first user message (raw); '' when absent. Lets the indexer detect an auto-derived title —
   *  Codex marks a title as a real rename only when it differs from this (see codexSessionIndex.ts). */
  firstUserMessage: string
  /** Codex's own archived flag (`archived` INTEGER, 0/1) — archived threads are hidden from its own
   *  list, so Switchboard drops them too, keeping the two browsers in sync. */
  archived: boolean
}

/**
 * Map of Codex sessionId (== threadId) -> { title, archived }, read from the newest `state_*.sqlite`.
 * Includes EVERY thread row, so the caller can both prefer the DB title and drop archived ids; the
 * title is the raw value ('' when absent) — the indexer applies the non-empty check. Returns an empty
 * map on any failure (missing DB, schema drift, or a readonly-open race while Codex is mid-write —
 * see the gotcha), leaving callers on their rollout-derived fallback.
 */
export function readCodexThreads(home: string = defaultCodexHome()): Map<string, CodexThreadRow> {
  const threads = new Map<string, CodexThreadRow>()
  const dbPath = newestStateDb(home)
  if (!dbPath) return threads

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db
      .prepare('SELECT id, title, first_user_message, archived FROM threads')
      .all() as Array<Record<string, unknown>>
    for (const row of rows) {
      if (typeof row.id !== 'string') continue
      threads.set(row.id, {
        title: typeof row.title === 'string' ? row.title : '',
        firstUserMessage: typeof row.first_user_message === 'string' ? row.first_user_message : '',
        archived: !!row.archived
      })
    }
  } catch {
    return threads
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
  return threads
}
