/**
 * Writing a conversation's title back to disk.
 *
 * Switchboard never *owns* conversation data — so a "rename" is just Claude Code's OWN record:
 * we append a `custom-title` line (exactly what the `/rename` slash command writes) to the session
 * JSONL. `resolveTitle` in the parser already takes the LAST `custom-title` at highest precedence,
 * so the appended line wins, and the rename is real — it survives into `claude --resume`.
 *
 * This is the one and only write path into the JSONL files; everything else here is read-only.
 *
 * Pure Node — no Electron, no DOM.
 */

import { appendFile } from 'node:fs/promises'

/** Defensive cap on the raw stored title; the parser additionally cleans + caps DISPLAY to 80. */
const RAW_TITLE_MAX = 200

/**
 * Append a `custom-title` line to a session JSONL, setting (or clearing) its title.
 *
 * An empty/whitespace `title` writes an empty custom title, which the parser treats as "no custom
 * title" (it cleans to '' and falls through to the auto-generated title) — the reset path.
 *
 * The write is append-only and atomic for a single small line (O_APPEND, via the implicit 'a'
 * flag), so it's safe alongside a live `claude` appending to the same file; claude also tolerates
 * duplicate `custom-title` lines (real session files repeat them on resume).
 */
export async function appendCustomTitle(
  filePath: string,
  sessionId: string,
  title: string
): Promise<void> {
  const trimmed = title.trim().slice(0, RAW_TITLE_MAX)
  const line = JSON.stringify({ type: 'custom-title', customTitle: trimmed, sessionId }) + '\n'
  await appendFile(filePath, line, 'utf8')
}
