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
      const extent = {
        start, end: cursor, selected: '',
        active: options.intent === 'complete' || window !== undefined || children.some(c => c.active),
        full: children.every(c => c.full),
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

const escapeText = (text: string): string => text.replace(/[\\`*_[\]]/g, '\\$&')
const escapeDestination = (url: string): string => '<' + url.replace(/\\/g, '\\\\').replace(/>/g, '\\>').replace(/\n/g, '%0A') + '>'
const linkTitle = (title?: string): string => title ? ' "' + title.replace(/[\\"]/g, '\\$&').replace(/\n/g, ' ') + '"' : ''

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

function joinRendered(nodes: CopyNode[], ctx: Context, separator: string, escaped = false): string {
  return nodes.map(node => render(node, ctx, escaped)).filter(part => part !== '').join(separator)
}
function itemBody(node: CopyNode & Children, ctx: Context, escaped: boolean): string {
  let out = ''
  let previous: CopyNode | undefined
  for (const child of node.children) {
    const value = render(child, ctx, escaped)
    if (!value) continue
    if (previous && (isBlock(previous) || isBlock(child))) {
      out += child.kind === 'list' || previous.kind === 'list' ? '\n' : '\n\n'
    }
    out += value
    previous = child
  }
  return out
}
function isBlock(node: CopyNode): boolean {
  return ['paragraph', 'flow', 'heading', 'quote', 'list', 'table', 'rule', 'tool'].includes(node.kind) ||
    (node.kind === 'code' && node.block) || (node.kind === 'math' && node.display)
}
function renderList(node: CopyNode & { kind: 'list' }, ctx: Context): string {
  const touched = node.children.filter(child => ctx.extents.get(child)!.meaningful).length
  const parts: string[] = []
  node.children.forEach((child, index) => {
    if (child.kind !== 'item' || !ctx.extents.get(child)!.active) return
    const extent = ctx.extents.get(child)!
    const marked = extent.full && (touched >= 2 || retained(child, ctx))
    const body = itemBody(child, ctx, false)
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
  const rows = node.children.filter(row => ctx.extents.get(row)!.active).map(row =>
    'children' in row ? row.children.filter(cell => ctx.extents.get(cell)!.active)
      .map(cell => render(cell, ctx, markdown)) : []
  ).filter(row => row.length > 0)
  if (!markdown) return rowsToText(rows)
  if (!rows.length) return ''
  const line = (row: string[]): string => '| ' + row.map(value => value.replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |'
  const separator = rows[0].map((_, i) => node.align[i] === 'center' ? ':---:' : node.align[i] === 'left' ? ':---' : node.align[i] === 'right' ? '---:' : '---')
  return [line(rows[0]), line(separator), ...rows.slice(1).map(line)].join('\n')
}

function render(node: CopyNode, ctx: Context, escaped = false): string {
  const extent = ctx.extents.get(node)!
  if (!extent.active) return ''
  const markdown = ctx.options.mode === 'markdown'
  const marked = markdown && retained(node, ctx)
  switch (node.kind) {
    case 'text': return markdown && escaped ? escapeText(extent.selected) : extent.selected
    case 'inline': case 'paragraph': case 'cell': case 'row':
      return joinRendered(node.children, ctx, '', escaped)
    case 'flow': return joinRendered(node.children, ctx, '\n\n', escaped)
    case 'strong': case 'em': case 'strike': {
      const body = joinRendered(node.children, ctx, '', escaped || marked)
      const marker = node.kind === 'strong' ? '**' : node.kind === 'em' ? '*' : '~~'
      return marked ? marker + body + marker : body
    }
    case 'heading': {
      const body = joinRendered(node.children, ctx, '', escaped || marked)
      return marked ? '#'.repeat(node.level) + ' ' + body : body
    }
    case 'quote': {
      const body = joinRendered(node.children, ctx, '\n\n', escaped || marked)
      return marked ? body.split('\n').map(line => line ? '> ' + line : '>').join('\n') : body
    }
    case 'link': {
      const body = joinRendered(node.children, ctx, '', escaped || marked)
      return marked ? `[${body}](${escapeDestination(node.url)}${linkTitle(node.title)})` : body
    }
    case 'code': return marked ? node.block ? fence(extent.selected, node.lang) : inlineCode(extent.selected) : extent.selected
    case 'math': return marked ? node.display ? `$$\n${extent.selected}\n$$` : `$${extent.selected}$` : extent.selected
    case 'image': return marked && node.url ? `![${escapeText(extent.selected)}](${escapeDestination(node.url)}${linkTitle(node.title)})` : extent.selected
    case 'tool': return retained(node, ctx) ? `${node.label}:\n\n${markdown ? fence(extent.selected, node.lang) : extent.selected}` : extent.selected
    case 'list': return renderList(node, ctx)
    case 'item': return itemBody(node, ctx, escaped)
    case 'table': return renderTable(node, ctx)
    case 'break': return marked ? '  \n' : extent.selected
    case 'rule': return retained(node, ctx) ? '---' : ''
  }
}

export function serializeCopy(nodes: CopyNode[], options: CopyOptions): string {
  const ctx = prepare(nodes, options)
  return joinRendered(nodes, ctx, '\n\n')
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
    ...section, body: joinRendered(section.nodes, ctx, '\n\n')
  })), options.mode, options.alwaysLabel)
}
