import { INLINE_STYLE, emitInline, hasInlineMarkup, planInline, type InlineRun, type InlineToken } from './mdCopyInline'

/** Semantic copy rules shared by the DOM selection and whole-document adapters. */
export type CopyMode = 'markdown' | 'plain'
export type CopyIntent = 'selection' | 'complete'
export type Alignment = 'left' | 'right' | 'center' | null

type Children = { children: CopyNode[] }
export type CopyNode =
  | { kind: 'text'; value: string }
  | ({ kind: 'flow' | 'inline' | 'paragraph' | 'strong' | 'em' | 'strike' | 'quote' | 'row' | 'cell' } & Children)
  | ({ kind: 'heading'; level: number } & Children)
  | ({ kind: 'link'; url: string; title?: string } & Children)
  | ({ kind: 'list'; start: number | null } & Children)
  | ({ kind: 'item'; checked?: boolean } & Children)
  | ({ kind: 'table'; align: Alignment[] } & Children)
  | { kind: 'code'; value: string; block: boolean; lang?: string }
  | { kind: 'math'; value: string; display: boolean }
  | { kind: 'image'; value: string; url?: string; title?: string }
  | { kind: 'tool'; value: string; label: string; lang?: string }
  | { kind: 'break' | 'rule' }

export interface CopyWindow { from: number; to: number }
/** Only intersected leaves need an entry. Empty selected cells also carry an entry. */
export type CopySelection = Map<CopyNode, CopyWindow>
export interface CopySection {
  label: string
  isSidechain: boolean
  nodes: CopyNode[]
}
export interface CopyOptions {
  mode: CopyMode
  intent: CopyIntent
  selection?: CopySelection
  alwaysLabel?: boolean
}
interface Extent {
  start: number
  end: number
  selected: string
  active: boolean
  full: boolean
  meaningful: boolean
}
interface Context {
  options: CopyOptions
  extents: WeakMap<CopyNode, Extent>
  first: number
  last: number
}

export const copyText = (value: string): CopyNode => ({ kind: 'text', value })

function prepare(nodes: CopyNode[], options: CopyOptions): Context {
  const ctx: Context = { options, extents: new WeakMap(), first: Infinity, last: -1 }
  let cursor = 0
  const visit = (node: CopyNode): Extent => {
    const start = cursor
    const window = options.selection?.get(node)
    if ('children' in node) {
      const children = node.children.map(visit)
      const active = options.intent === 'complete' || window !== undefined || children.some(c => c.active)
      const extent = {
        start, end: cursor, selected: '',
        active,
        // Empty cells still occupy columns; text completeness alone cannot prove their coverage.
        full: (node.kind !== 'cell' || active) && children.every(c => c.full),
        meaningful: children.some(c => c.meaningful)
      }
      ctx.extents.set(node, extent)
      return extent
    }
    const value = 'value' in node ? node.value : node.kind === 'break' ? '\n' : ''
    const from = options.intent === 'complete' ? 0 : Math.max(0, Math.min(window?.from ?? 0, value.length))
    const to = options.intent === 'complete' ? value.length : Math.max(from, Math.min(window?.to ?? 0, value.length))
    const selected = value.slice(from, to)
    const first = selected.search(/\S/)
    if (first >= 0) {
      ctx.first = Math.min(ctx.first, start + from + first)
      ctx.last = Math.max(ctx.last, start + to - 1)
    }
    cursor += value.length
    const contentStart = value.search(/\S/)
    const contentEnd = value.search(/\s*$/)
    const extent = {
      start, end: cursor, selected,
      active: options.intent === 'complete' || window !== undefined,
      full: contentStart < 0 || (from <= contentStart && to >= contentEnd),
      meaningful: first >= 0
    }
    ctx.extents.set(node, extent)
    return extent
  }
  nodes.forEach(visit)
  return ctx
}

function retained(node: CopyNode, ctx: Context): boolean {
  const extent = ctx.extents.get(node)!
  return ctx.options.intent === 'complete' ||
    (extent.full && (ctx.first < extent.start || ctx.last >= extent.end))
}

// Table splitting happens before inline parsing; an odd backslash run already protects a pipe.
const escapeTablePipes = (text: string): string => text.replace(/(\\*)\|/g,
  (pipe, slashes: string) => slashes.length % 2 ? pipe : slashes + '\\|')
// Ampersands must stay literal in metadata; otherwise Markdown decodes entity-looking values.
const escapeDestination = (url: string): string => '<' + url.replace(/[\\<>&]/g, '\\$&').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;') + '>'
// Escape literal ampersands before introducing references for title line endings.
const linkTitle = (title?: string): string => title ? ' "' + title.replace(/[\\"&]/g, '\\$&').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;') + '"' : ''

function longestBackticks(value: string): number {
  return (value.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
}
export function fence(body: string, lang = ''): string {
  const longest = longestBackticks(body)
  const bar = '`'.repeat(Math.max(3, longest + 1))
  return `${bar}${lang.replace(/[\r\n`]/g, '')}\n${body}\n${bar}`
}
function inlineCode(value: string): string {
  const bar = '`'.repeat(longestBackticks(value) + 1)
  const pad = value.startsWith('`') || value.endsWith('`') ||
    (value.startsWith(' ') && value.endsWith(' ') && /\S/.test(value)) ? ' ' : ''
  return `${bar}${pad}${value}${pad}${bar}`
}

/** Field quoting is structural encoding, not Markdown styling. Single cells remain unquoted. */
export function rowsToText(rows: string[][]): string {
  const multiple = rows.reduce((n, row) => n + row.length, 0) > 1
  const field = (value: string): string => multiple && /[\t\r\n"]/.test(value)
    ? '"' + value.replace(/"/g, '""') + '"' : value
  return rows.map(row => row.map(field).join('\t')).join('\n')
}

/** Eligibility belongs to the original selection, before equivalent style runs are grouped. */
function inlineRuns(nodes: CopyNode[], ctx: Context, inherited = 0): InlineRun[] {
  const runs: InlineRun[] = []
  const visit = (children: CopyNode[], styles: number): void => {
    for (const node of children) {
      const extent = ctx.extents.get(node)!
      if (!extent.active) continue
      const marked = ctx.options.mode === 'markdown' && retained(node, ctx)
      if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'strike') {
        visit(node.children, styles | (marked ? INLINE_STYLE[node.kind] : 0))
        continue
      }
      if (node.kind === 'inline') { visit(node.children, styles); continue }
      let tokens: InlineToken[]
      switch (node.kind) {
        case 'text': tokens = extent.selected ? [{ kind: 'text', value: extent.selected }] : []; break
        case 'link': {
          const label = planInline(inlineRuns(node.children, ctx, styles), styles)
          tokens = marked ? [{ kind: 'atom', value: '[' }, ...label,
            { kind: 'atom', value: `](${escapeDestination(node.url)}${linkTitle(node.title)})` }] : label
          break
        }
        case 'image':
          tokens = marked && node.url !== undefined ? [{ kind: 'atom', value: '![' },
            { kind: 'text', value: extent.selected },
            { kind: 'atom', value: `](${escapeDestination(node.url)}${linkTitle(node.title)})` }]
            : [{ kind: 'text', value: extent.selected }]
          break
        case 'code':
          tokens = [{ kind: marked ? node.block ? 'atom' : 'code' : 'text', value: marked
            ? node.block ? fence(extent.selected, node.lang) : inlineCode(extent.selected) : extent.selected }]
          break
        case 'math':
          tokens = [{ kind: marked ? node.display ? 'atom' : 'math' : 'text', value: marked
            ? node.display ? `$$\n${extent.selected}\n$$` : `$${extent.selected}$` : extent.selected }]
          break
        case 'break': tokens = [{ kind: 'break', marked }]; break
        default: tokens = [{ kind: 'atom', value: render(node, ctx) }]
      }
      tokens = tokens.filter(token => token.kind === 'break' || token.value !== '')
      if (tokens.length) runs.push({ styles, tokens })
    }
  }
  visit(nodes, inherited)
  return runs
}
function renderInline(nodes: CopyNode[], ctx: Context, escaped = false): string {
  const tokens = planInline(inlineRuns(nodes, ctx))
  return emitInline(tokens, ctx.options.mode === 'markdown' && (escaped || hasInlineMarkup(tokens)))
}
/** Separate copy units retain a paragraph boundary even when their payload is inline. */
function renderBlocks(nodes: CopyNode[], ctx: Context): string {
  return nodes.map(node => render(node, ctx)).filter(part => part !== '').join('\n\n')
}
function renderFlow(nodes: CopyNode[], ctx: Context, escaped = false, listItem = false): string {
  let out = ''
  let previous: CopyNode | undefined
  let inline: CopyNode[] = []
  const append = (value: string, child: CopyNode): void => {
    if (!value) return
    if (previous && (isCopyBlock(previous) || isCopyBlock(child))) {
      out += listItem && (child.kind === 'list' || previous.kind === 'list') ? '\n' : '\n\n'
    }
    out += value
    previous = child
  }
  const flush = (): void => {
    if (!inline.length) return
    append(renderInline(inline, ctx, escaped), inline[inline.length - 1])
    inline = []
  }
  for (const child of nodes) {
    if (!ctx.extents.get(child)!.active) continue
    if (isCopyBlock(child)) {
      const value = render(child, ctx, escaped)
      if (!value) continue
      flush()
      append(value, child)
    } else inline.push(child)
  }
  flush()
  return out
}
export function isCopyBlock(node: CopyNode): boolean {
  return ['paragraph', 'flow', 'heading', 'quote', 'list', 'item', 'table', 'rule', 'tool'].includes(node.kind) ||
    (node.kind === 'code' && node.block) || (node.kind === 'math' && node.display)
}
function renderList(node: CopyNode & { kind: 'list' }, ctx: Context, escaped: boolean): string {
  const touched = node.children.filter(child => ctx.extents.get(child)!.meaningful).length
  const parts: string[] = []
  node.children.forEach((child, index) => {
    if (child.kind !== 'item' || !ctx.extents.get(child)!.active) return
    const extent = ctx.extents.get(child)!
    const marked = extent.full && (touched >= 2 || retained(child, ctx))
    const body = renderFlow(child.children, ctx, escaped || marked, true)
    if (!marked) { parts.push(body); return }
    const bullet = node.start === null ? '- ' : `${node.start + index}. `
    const task = child.checked === undefined ? '' : `[${child.checked ? 'x' : ' '}] `
    const marker = bullet + task
    parts.push(marker + body.replace(/\n/g, '\n' + ' '.repeat(bullet.length)))
  })
  return parts.join('\n')
}
function renderTable(node: CopyNode & { kind: 'table' }, ctx: Context): string {
  const markdown = ctx.options.mode === 'markdown' && retained(node, ctx)
  const plans = node.children.filter(row => ctx.extents.get(row)!.active).map(row =>
    'children' in row ? row.children.filter(cell => ctx.extents.get(cell)!.active)
      .map(cell => planInline(inlineRuns('children' in cell ? cell.children : [cell], ctx))) : []
  ).filter(row => row.length > 0)
  const protect = ctx.options.mode === 'markdown' && (markdown || plans.some(row => row.some(hasInlineMarkup)))
  const rows = plans.map(row => row.map(tokens => emitInline(tokens, protect)))
  if (!markdown) return rowsToText(rows)
  if (!rows.length) return ''
  const line = (row: string[]): string => '| ' + row.map(value => escapeTablePipes(value).replace(/\n/g, '<br>')).join(' | ') + ' |'
  const separator = rows[0].map((_, i) => node.align[i] === 'center' ? ':---:' : node.align[i] === 'left' ? ':---' : node.align[i] === 'right' ? '---:' : '---')
  return [line(rows[0]), line(separator), ...rows.slice(1).map(line)].join('\n')
}

function render(node: CopyNode, ctx: Context, escaped = false): string {
  const extent = ctx.extents.get(node)!
  if (!extent.active) return ''
  const markdown = ctx.options.mode === 'markdown'
  const marked = markdown && retained(node, ctx)
  switch (node.kind) {
    case 'text': return renderInline([node], ctx, escaped)
    case 'inline': case 'paragraph': case 'cell': case 'row':
      return renderInline(node.children, ctx, escaped)
    case 'flow': return renderFlow(node.children, ctx, escaped)
    case 'strong': case 'em': case 'strike': return renderInline([node], ctx, escaped)
    case 'heading': {
      const body = renderInline(node.children, ctx, escaped || marked)
      return marked ? '#'.repeat(node.level) + ' ' + body : body
    }
    case 'quote': {
      const body = renderFlow(node.children, ctx, escaped || marked)
      return marked ? body.split('\n').map(line => line ? '> ' + line : '>').join('\n') : body
    }
    case 'link': case 'image': case 'break': return renderInline([node], ctx, escaped)
    case 'code': return node.block ? marked ? fence(extent.selected, node.lang) : extent.selected : renderInline([node], ctx, escaped)
    case 'math': return node.display ? marked ? `$$\n${extent.selected}\n$$` : extent.selected : renderInline([node], ctx, escaped)
    case 'tool': return retained(node, ctx) ? `${node.label}:\n\n${markdown ? fence(extent.selected, node.lang) : extent.selected}` : extent.selected
    case 'list': return renderList(node, ctx, escaped)
    case 'item': return renderFlow(node.children, ctx, escaped, true)
    case 'table': return renderTable(node, ctx)
    case 'rule': return retained(node, ctx) ? '---' : ''
  }
}

export function serializeCopy(nodes: CopyNode[], options: CopyOptions): string {
  const ctx = prepare(nodes, options)
  return renderBlocks(nodes, ctx)
}
export function joinCopySections(
  sections: { label: string; isSidechain: boolean; body: string }[],
  mode: CopyMode,
  alwaysLabel = false
): string {
  const kept = sections.filter(section => section.body !== '')
  if (kept.length === 1 && !alwaysLabel) return kept[0].body
  return kept.map(section => {
    const label = section.label + (section.isSidechain ? ' (Sub-agent)' : '')
    return `${mode === 'markdown' ? `**${label}:**` : `${label}:`}\n\n${section.body}`
  }).join('\n\n---\n\n')
}
export function assembleCopy(sections: CopySection[], options: CopyOptions): string {
  const ctx = prepare(sections.flatMap(section => section.nodes), options)
  return joinCopySections(sections.map(section => ({
    ...section, body: renderBlocks(section.nodes, ctx)
  })), options.mode, options.alwaysLabel)
}
