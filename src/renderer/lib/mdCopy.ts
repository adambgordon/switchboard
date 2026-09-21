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

const escapeText = (text: string): string => text.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '\\$&')
// Table splitting happens before inline parsing; an odd backslash run already protects a pipe.
const escapeTablePipes = (text: string): string => text.replace(/(\\*)\|/g,
  (pipe, slashes: string) => slashes.length % 2 ? pipe : slashes + '\\|')
const escapeDestination = (url: string): string => '<' + url.replace(/[\\<>&]/g, '\\$&').replace(/\n/g, '%0A') + '>'
const linkTitle = (title?: string): string => title ? ' "' + title.replace(/[\\"&]/g, '\\$&').replace(/\n/g, ' ') + '"' : ''

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

const STYLE = { em: 1, strong: 2, strike: 4 } as const
interface InlineRun { text: string; styles: number }

/** Eligibility belongs to the original selection, before equivalent style runs are grouped. */
function inlineRuns(nodes: CopyNode[], ctx: Context, escaped: boolean): InlineRun[] {
  const runs: InlineRun[] = []
  const visit = (children: CopyNode[], styles: number, escape: boolean): void => {
    for (const node of children) {
      if (!ctx.extents.get(node)!.active) continue
      if (node.kind === 'strong' || node.kind === 'em' || node.kind === 'strike') {
        const marked = ctx.options.mode === 'markdown' && retained(node, ctx)
        visit(node.children, styles | (marked ? STYLE[node.kind] : 0), escape || marked)
      } else if (node.kind === 'inline') {
        visit(node.children, styles, escape)
      } else {
        const text = render(node, ctx, escape)
        if (!text) continue
        const previous = runs[runs.length - 1]
        if (previous?.styles === styles) previous.text += text
        else runs.push({ text, styles })
      }
    }
  }
  visit(nodes, 0, escaped)
  return runs
}

function serializeInline(runs: InlineRun[], from = 0, to = runs.length, inherited = 0): string {
  const parts: string[] = []
  for (let index = from; index < to;) {
    const styles = runs[index].styles & ~inherited
    if (!styles) { parts.push(runs[index++].text); continue }
    let style = 0, end = index
    // Keep shared attention open across run boundaries instead of fusing closing/opening stars.
    for (const candidate of [STYLE.em, STYLE.strong]) {
      let limit = index
      while (limit < to && (runs[limit].styles & ~inherited & candidate)) limit++
      if (limit > end) { style = candidate; end = limit }
    }
    if (!style) {
      // Strike stays innermost: lifting it around attention changes its delimiter flanking.
      style = STYLE.strike
      end = index + 1
      while (end < to && (runs[end].styles & ~inherited) === STYLE.strike) end++
    }
    const marker = style === STYLE.em ? '*' : style === STYLE.strong ? '**' : '~~'
    const body = serializeInline(runs, index, end, inherited | style)
    // Whitespace at a delimiter edge prevents it from opening/closing. Keep the bytes outside.
    const leading = body.match(/^\s*/)![0]
    const rest = body.slice(leading.length)
    const content = rest.trimEnd()
    const trailing = rest.slice(content.length)
    parts.push(leading, content ? marker + content + marker : '', trailing)
    index = end
  }
  return parts.join('')
}

function renderInline(nodes: CopyNode[], ctx: Context, escaped = false): string {
  return serializeInline(inlineRuns(nodes, ctx, escaped))
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
  const rows = node.children.filter(row => ctx.extents.get(row)!.active).map(row =>
    'children' in row ? row.children.filter(cell => ctx.extents.get(cell)!.active)
      .map(cell => render(cell, ctx, markdown)) : []
  ).filter(row => row.length > 0)
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
    case 'text': return markdown && escaped ? escapeText(extent.selected) : extent.selected
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
    case 'link': {
      const body = renderInline(node.children, ctx, escaped || marked)
      return marked ? `[${body}](${escapeDestination(node.url)}${linkTitle(node.title)})` : body
    }
    case 'code': return marked ? node.block ? fence(extent.selected, node.lang) : inlineCode(extent.selected) : extent.selected
    case 'math': return marked ? node.display ? `$$\n${extent.selected}\n$$` : `$${extent.selected}$` : extent.selected
    case 'image': return marked && node.url ? `![${escapeText(extent.selected)}](${escapeDestination(node.url)}${linkTitle(node.title)})` : extent.selected
    case 'tool': return retained(node, ctx) ? `${node.label}:\n\n${markdown ? fence(extent.selected, node.lang) : extent.selected}` : extent.selected
    case 'list': return renderList(node, ctx, escaped)
    case 'item': return renderFlow(node.children, ctx, escaped, true)
    case 'table': return renderTable(node, ctx)
    case 'break': return marked ? '  \n' : extent.selected
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
