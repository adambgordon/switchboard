import type { AgentKind, TranscriptMessage } from '../../shared/types'
import { joinCopySections, rowsToText, serializeCopy, type CopyMode } from './mdCopy'
import { markdownCopyNodes } from './mdCopyAst'
import { buildTranscript } from './messageGroups'

/**
 * Render a grid of cells (row 0 = header) as a GitHub-flavored markdown table — the format the
 * transcript's table copy button produces. Columns are space-padded to a common width (min 3, so the
 * `---` separator never out-runs its column) so the source reads cleanly in a plain editor; cell
 * newlines collapse to spaces and literal `|` is escaped. Returns '' for no rows.
 */
export function rowsToMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return ''
  const esc = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
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

export function rowsToPlainText(rows: string[][]): string {
  return rowsToText(rows)
}

export function markdownToPlainText(source: string): string {
  return serializeCopy(markdownCopyNodes(source), { mode: 'plain', intent: 'complete' })
}

/** Complete-content actions omit tools regardless of disclosure or mount state. */
export function turnText(messages: TranscriptMessage[], mode: CopyMode = 'markdown'): string {
  return messages.flatMap(message => message.blocks.flatMap(block => {
    if (block.kind === 'image') return [block.alt.trim() ? block.alt : 'image']
    if (block.kind !== 'text') return []
    return [mode === 'markdown' ? block.text : markdownToPlainText(block.text)]
  })).filter(part => part !== '').join('\n\n')
}

export function conversationText(
  messages: TranscriptMessage[], agent: AgentKind, mode: CopyMode = 'markdown'
): string {
  const sections = buildTranscript(messages, agent).flatMap(item => {
    if (item.kind !== 'section') return []
    const messages = item.items.flatMap(part => part.kind === 'turn' ? part.messages : [])
    return [{ label: item.label, isSidechain: item.isSidechain, body: turnText(messages, mode) }]
  })
  return joinCopySections(sections, mode, true)
}
