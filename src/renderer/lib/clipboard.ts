// Relative imports (not the @shared alias) so this stays unit-testable under vitest.
import type { AgentKind, TranscriptMessage } from '../../shared/types'
import { buildTranscript } from './messageGroups'

/**
 * Pure clipboard text builders for the Formatted view's copy affordances. Kept DOM-free so they're
 * unit-testable under vitest's node environment (the component does the DOM reading and hands rows in).
 */

/**
 * Render a grid of cells (row 0 = header) as a GitHub-flavored markdown table — the format the
 * transcript's table copy button produces. Columns are space-padded to a common width (min 3, so the
 * `---` separator never out-runs its column) so the source reads cleanly in a plain editor; cell
 * newlines collapse to spaces and literal `|` is escaped. Returns '' for no rows.
 */
export function rowsToMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const esc = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
  const cells = rows.map((r) => r.map(esc))
  const cols = Math.max(...cells.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...cells.map((r) => (r[c] ?? '').length))
  )
  const pad = (s: string, c: number): string => s + ' '.repeat(widths[c] - s.length)
  const line = (r: string[]): string =>
    '| ' + Array.from({ length: cols }, (_, c) => pad(r[c] ?? '', c)).join(' | ') + ' |'
  const sep = '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |'
  const [header, ...body] = cells
  return [line(header), sep, ...body.map(line)].join('\n')
}

/**
 * The whole-turn copy text: the raw markdown source of a group's text blocks, joined by a blank line.
 * The assistant's text is stored AS markdown, so this preserves headers, bold, inline code, fenced
 * code blocks, and pipe tables verbatim (with the author's own blank-line spacing). Non-text blocks —
 * tool calls (the ⚙ gear), tool results, images — are skipped, so tool I/O never lands in the copy.
 */
export function turnMarkdown(messages: TranscriptMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.kind === 'text') parts.push(b.text)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * A readable Markdown export of the whole Formatted conversation. Reusing the render sections keeps
 * attribution identical to the UI; turnMarkdown deliberately drops tool I/O and images.
 */
export function conversationMarkdown(messages: TranscriptMessage[], agent: AgentKind): string {
  const sections: string[] = []
  for (const item of buildTranscript(messages, agent)) {
    if (item.kind !== 'section') continue
    const proseMessages = item.items.flatMap((part) => (part.kind === 'turn' ? part.messages : []))
    const body = turnMarkdown(proseMessages)
    if (!body) continue
    const label = item.isSidechain ? `${item.label} (Sub-agent)` : item.label
    sections.push(`**${label}:**\n\n${body}`)
  }
  return sections.join('\n\n---\n\n')
}
