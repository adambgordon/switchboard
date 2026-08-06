// Relative imports (not the @shared alias) so this stays unit-testable under vitest.
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { AgentKind, TranscriptMessage } from '../../shared/types'
import { assembleCopy, type CopySection } from './mdCopy'
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

/** Render a grid of cells as plain text — one tab-separated line per row, no pipes or padding. What the
 *  table copy button produces with "Copy as markdown" turned off. */
export function rowsToPlainText(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => c.replace(/\r?\n/g, ' ').trim()).join('\t'))
    .join('\n')
}

/* ------------------------------------------------------------------ *
 * Markdown → plain text.
 *
 * Only the WHOLE-CONVERSATION export needs this. Everywhere else, plain text comes off the DOM, which
 * is exact by construction — but the transcript mounts only its last ~60 sections, so an export cannot
 * read text for messages that were never rendered. Parsing is the alternative, and mdast is the right
 * tool: regex-stripping markdown gets fences, nested emphasis, and tables wrong.
 *
 * Structure that is VISIBLE in the Formatted view is kept (list bullets, table columns, code bodies);
 * syntax that only produces styling is dropped. So this approximates the rendered text rather than
 * matching it byte-for-byte — an inline image is its alt text here, where the view shows a 🖼 chip.
 * ------------------------------------------------------------------ */

interface MdNode {
  type: string
  value?: string
  alt?: string
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  depth?: number
  children?: MdNode[]
}

/** Blocks that stand alone in the reading flow, separated by a blank line like paragraphs. */
const BLOCK = new Set(['paragraph', 'heading', 'code', 'blockquote', 'table', 'list', 'thematicBreak'])

function inlineText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  if (node.type === 'break') return '\n'
  if (node.type === 'image') return node.alt ?? ''
  return (node.children ?? []).map(inlineText).join('')
}

function blockText(node: MdNode, depth = 0): string {
  switch (node.type) {
    case 'code':
      return node.value ?? ''
    case 'thematicBreak':
      return '---'
    case 'list': {
      const items = node.children ?? []
      const start = node.start ?? 1
      return items
        .map((item, i) => {
          const marker = node.ordered ? `${start + i}. ` : '- '
          const task = item.checked == null ? '' : `[${item.checked ? 'x' : ' '}] `
          const body = (item.children ?? []).map((c) => blockText(c, depth + 1)).join('\n')
          const pad = '  '.repeat(depth)
          // Indent continuation lines to the marker so nested content stays visually attached.
          return `${pad}${marker}${task}${body.replace(/\n/g, `\n${pad}  `)}`
        })
        .join('\n')
    }
    case 'table':
      return (node.children ?? [])
        .map((row) => (row.children ?? []).map((cell) => inlineText(cell).trim()).join('\t'))
        .join('\n')
    case 'blockquote':
      return (node.children ?? []).map((c) => blockText(c, depth)).join('\n\n')
    default:
      if (BLOCK.has(node.type) || node.children) return inlineText(node)
      return node.value ?? ''
  }
}

/** Strip markdown syntax from `md`, keeping the structure the Formatted view actually shows. */
export function markdownToPlainText(md: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(md) as unknown as MdNode
  return (tree.children ?? [])
    .map((n) => blockText(n))
    .filter((s) => s.trim())
    .join('\n\n')
    .trim()
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
 *
 * Shares `assembleCopy` with the selection copy so the two can't drift apart on labelling or spacing —
 * `alwaysLabel` is the one difference: a whole-conversation export names its speaker even when there's
 * only one, where a selection that never leaves a single section comes back bare.
 */
export function conversationMarkdown(
  messages: TranscriptMessage[],
  agent: AgentKind,
  mode: 'markdown' | 'plain' = 'markdown'
): string {
  const sections: CopySection[] = []
  for (const item of buildTranscript(messages, agent)) {
    if (item.kind !== 'section') continue
    const proseMessages = item.items.flatMap((part) => (part.kind === 'turn' ? part.messages : []))
    const body = turnMarkdown(proseMessages)
    sections.push({
      label: item.label,
      isSidechain: item.isSidechain,
      parts: [mode === 'plain' ? markdownToPlainText(body) : body]
    })
  }
  return assembleCopy(sections, true, mode === 'plain')
}
