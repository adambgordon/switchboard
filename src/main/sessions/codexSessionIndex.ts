/**
 * Reading a Codex conversation's durable custom name from Codex's session index.
 *
 * A Codex rename writes TWO places: the volatile `threads.title` column in `state_*.sqlite`
 * (codexThreadsDb.ts) AND an append-only log at `~/.codex/session_index.jsonl`. The DB column is
 * disposable — resuming a thread rebuilds it from the rollout (which carries no name), so Codex
 * re-derives `threads.title` from the first user message on the next turn, clobbering the rename.
 * The session index is NOT touched by resume, so the custom name survives there.
 *
 * Codex's own conversation list resolves the displayed name the same way (codex-rs
 * thread-store `list_threads.rs`): prefer the DB title only when it is "distinct" (differs from the
 * first user message); otherwise fall back to the session-index name. {@link resolveCodexTitle}
 * mirrors that order so Switchboard shows what Codex shows, even after a rename has reverted in the
 * DB column.
 *
 * Each line is `{ id, thread_name, updated_at }`; the file is append-only and newest-wins (a rename
 * appends a new line; clearing a name appends an empty one). Pure Node — no Electron, no DOM.
 * Synchronous (the file is tiny — one line per rename). Every failure degrades to an empty map /
 * the prior fallback; the read must never crash the index.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defaultCodexHome } from './codexThreadsDb'

/** Codex's session-index filename under `~/.codex`. */
const SESSION_INDEX_FILE = 'session_index.jsonl'

/**
 * Map of Codex sessionId (== threadId) -> newest custom name from `session_index.jsonl`. The file is
 * append-only and newest-wins, so a later line for an id supersedes earlier ones; a newest entry
 * whose `thread_name` is empty/whitespace is a CLEARED rename, so the id is omitted (callers fall
 * back to the auto title). Malformed lines are skipped; a missing/unreadable file yields an empty map.
 */
export function readCodexSessionNames(home: string = defaultCodexHome()): Map<string, string> {
  const names = new Map<string, string>()
  let text: string
  try {
    text = readFileSync(path.join(home, SESSION_INDEX_FILE), 'utf8')
  } catch {
    return names
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: { id?: unknown; thread_name?: unknown }
    try {
      entry = JSON.parse(trimmed)
    } catch {
      continue // tolerate a partial/corrupt line
    }
    if (typeof entry.id !== 'string') continue
    const name = typeof entry.thread_name === 'string' ? entry.thread_name : ''
    // Newest-wins: a later line overrides; an empty name clears (so we fall back to the auto title).
    if (name.trim().length > 0) names.set(entry.id, name)
    else names.delete(entry.id)
  }
  return names
}

/** The three places a Codex conversation's title can come from, in priority order. */
export interface CodexTitleSources {
  /** Switchboard's rollout-derived title (`codexParser`'s `cleanTitle(firstUser)`) — last resort. */
  rolloutTitle: string
  /** Raw `threads.title` from the state DB, or null when there's no row. */
  dbTitle: string | null
  /** Raw `threads.first_user_message` from the state DB, or null — used to detect an auto title. */
  dbFirstUserMessage: string | null
  /** Newest custom name from the session index, or null when none. */
  sessionName: string | null
}

/**
 * Resolve the title Switchboard should display, mirroring Codex's own resolution order:
 *   1. The DB title when it is DISTINCT (non-empty and != the first user message) — a real rename
 *      still present in the column (e.g. just renamed, not yet reverted by a resume).
 *   2. Else the session-index name — the durable rename, used once the DB title has been re-derived
 *      back to the first message on resume. This is the case the prior DB-title-only read missed.
 *   3. Else the DB title when present (an auto-derived first-message title) — prior behavior.
 *   4. Else the rollout-derived title.
 */
export function resolveCodexTitle(sources: CodexTitleSources): string {
  const dbTitle = (sources.dbTitle ?? '').trim()
  const firstUser = (sources.dbFirstUserMessage ?? '').trim()
  const sessionName = (sources.sessionName ?? '').trim()

  if (dbTitle.length > 0 && dbTitle !== firstUser) return dbTitle
  if (sessionName.length > 0) return sessionName
  if (dbTitle.length > 0) return dbTitle
  return sources.rolloutTitle
}
