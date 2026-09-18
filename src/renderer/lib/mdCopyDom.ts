import {
  assembleCopy, copyText, serializeCopy,
  type Alignment, type CopyMode, type CopyNode, type CopySection, type CopySelection, type CopyWindow
} from './mdCopy'

function skipped(el: Element): boolean {
  return el.hasAttribute('data-md-skip') || el.tagName === 'BUTTON' || el.tagName === 'INPUT' ||
    el.hasAttribute('data-footnote-backref') || el.classList.contains('sr-only')
}
function texts(el: Element, includeSkipped = false): Text[] {
  const out: Text[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node as Text); return }
    if (node.nodeType !== Node.ELEMENT_NODE || (!includeSkipped && skipped(node as Element))) return
    for (const child of Array.from(node.childNodes)) visit(child)
  }
  visit(el)
  return out
}
const visibleText = (el: Element): string => texts(el).map(node => node.data).join('')

export const isInlineCode = (el: Element): boolean =>
  el.classList.contains('md-code') && el.closest('pre') === null

function intersects(range: Range, el: Node): boolean {
  return range.intersectsNode(el)
}
function textWindow(node: Text, range: Range): CopyWindow {
  const from = range.startContainer === node ? range.startOffset : range.comparePoint(node, 0) < 0 ? node.length : 0
  const to = range.endContainer === node ? range.endOffset : range.comparePoint(node, node.length) > 0 ? 0 : node.length
  return { from, to: Math.max(from, to) }
}
function textOffset(el: Element, container: Node, offset: number): number {
  const boundary = document.createRange()
  boundary.setStart(container, offset)
  boundary.collapse(true)
  let total = 0
  for (const node of texts(el)) {
    if (node === container) return total + Math.min(offset, node.length)
    if (boundary.comparePoint(node, 0) >= 0) return total
    total += node.length
  }
  return total
}
function windowIn(el: Element, range: Range, length: number): CopyWindow {
  const from = el.contains(range.startContainer) ? textOffset(el, range.startContainer, range.startOffset) : 0
  const to = el.contains(range.endContainer) ? textOffset(el, range.endContainer, range.endOffset) : length
  return { from: Math.min(from, length), to: Math.min(to, length) }
}
function containsContents(range: Range, el: Element): boolean {
  const contents = rangeOver(el)
  return range.compareBoundaryPoints(Range.START_TO_START, contents) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, contents) >= 0
}

/** The clamp hides wrapped lines, not a fixed number of source newlines. Measure only on copy. */
function displayedLength(pre: Element, length: number): number {
  const clip = pre.closest('.tool-result-clip.is-clamped')
  if (!clip) return length
  const bounds = clip.getBoundingClientRect()
  if (pre.getBoundingClientRect().bottom <= bounds.bottom + 0.25) return length
  const leaves = texts(pre)
  const point = (offset: number): [Text, number] => {
    for (const leaf of leaves) {
      if (offset < leaf.length) return [leaf, offset]
      offset -= leaf.length
    }
    const last = leaves[leaves.length - 1]
    return [last, last.length]
  }
  const probe = document.createRange()
  const visible = (at: number): boolean => {
    probe.setStart(...point(at))
    probe.setEnd(...point(Math.min(length, at + 1)))
    return Array.from(probe.getClientRects()).some(rect => rect.top < bounds.bottom - 0.25 && rect.bottom > bounds.top)
  }
  let lo = 0, hi = length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (visible(mid)) lo = mid + 1
    else hi = mid
  }
  const full = visibleText(pre)
  if (lo > 0 && /[\uD800-\uDBFF]/.test(full[lo - 1]) && /[\uDC00-\uDFFF]/.test(full[lo] ?? '')) lo -= 1
  return lo
}

interface Reader { range?: Range; selection: CopySelection }
function selectLeaf(node: CopyNode, el: Element, reader: Reader, length: number, atomic = false): CopyNode {
  const range = reader.range
  if (!range) return node
  if (!intersects(range, el)) return node
  if (atomic) {
    if (texts(el, true).some(text => { const w = textWindow(text, range); return w.to > w.from })) {
      reader.selection.set(node, { from: 0, to: length })
    }
  } else {
    const window = windowIn(el, range, length)
    if (window.to > window.from || (length === 0 && containsContents(range, el))) reader.selection.set(node, window)
  }
  return node
}
function readText(text: Text, reader: Reader): CopyNode | null {
  // GFM inserts one presentation space after a task checkbox; it is not item content.
  const taskSpace = text.previousSibling instanceof HTMLInputElement && text.data.startsWith(' ') ? 1 : 0
  const value = text.data.slice(taskSpace)
  if (!value) return null
  const node = copyText(value)
  if (reader.range) {
    const window = textWindow(text, reader.range)
    const from = Math.max(0, window.from - taskSpace)
    const to = Math.max(0, window.to - taskSpace)
    if (to > from) reader.selection.set(node, { from, to })
  }
  return node
}
function children(el: Element, reader: Reader, flow = false): CopyNode[] {
  const out: CopyNode[] = []
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (flow && !(child.nodeValue ?? '').trim()) continue
      const node = readText(child as Text, reader)
      if (node) out.push(node)
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const node = readElement(child as Element, reader)
      if (node) out.push(node)
    }
  }
  return out
}
function readTable(el: HTMLTableElement, reader: Reader): CopyNode {
  const rows: CopyNode[] = Array.from(el.rows).map(row => ({
    kind: 'row', children: Array.from(row.cells).map(cell => {
      const node: CopyNode = { kind: 'cell', children: children(cell, reader) }
      if (reader.range && containsContents(reader.range, cell)) reader.selection.set(node, { from: 0, to: 0 })
      return node
    })
  }))
  const align = Array.from(el.rows[0]?.cells ?? []).map(cell => {
    const value = cell.style.textAlign
    return value === 'left' || value === 'right' || value === 'center' ? value : null
  }) as Alignment[]
  return { kind: 'table', align, children: rows }
}
function readElement(el: Element, reader: Reader): CopyNode | null {
  if (skipped(el)) return null
  if (el.matches('.md-math, .md-math-display, .md-math-src')) {
    const value = el.querySelector('.md-math-tex')?.textContent ?? visibleText(el)
    return selectLeaf({ kind: 'math', value, display: el.classList.contains('md-math-display') }, el, reader, value.length, true)
  }
  if (el.matches('.md-image, .transcript-image')) {
    const label = el.querySelector('[data-copy-label]') ?? el
    const value = visibleText(label)
    return selectLeaf({ kind: 'image', value, url: el.getAttribute('data-copy-url') ?? undefined,
      title: el.getAttribute('data-copy-title') ?? undefined }, label, reader, value.length)
  }
  if (el.tagName === 'PRE' || isInlineCode(el)) {
    const block = el.tagName === 'PRE'
    const value = block ? visibleText(el).replace(/\n$/, '') : visibleText(el)
    const lang = el.getAttribute('data-copy-lang') ?? undefined
    return selectLeaf({ kind: 'code', value, block, lang }, el, reader, value.length)
  }
  if (el.tagName === 'TABLE') return readTable(el as HTMLTableElement, reader)
  if (el.tagName === 'BR' || el.tagName === 'HR') {
    const node: CopyNode = { kind: el.tagName === 'BR' ? 'break' : 'rule' }
    if (reader.range && containsContents(reader.range, el)) reader.selection.set(node, { from: 0, to: node.kind === 'break' ? 1 : 0 })
    return node
  }
  const tag = el.tagName
  const flow = ['DIV', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'SECTION'].includes(tag)
  const kids = children(el, reader, flow)
  // The text newline immediately following <br> is a renderer contribution of that break.
  if (tag === 'P' || tag === 'LI') {
    for (let i = 1; i < kids.length; i++) {
      const node = kids[i]
      if (kids[i - 1].kind !== 'break' || node.kind !== 'text' || !node.value.startsWith('\n')) continue
      const window = reader.selection.get(node)
      if (window && window.from === 0 && window.to > 0) reader.selection.set(kids[i - 1], { from: 0, to: 1 })
      node.value = node.value.slice(1)
      if (window) reader.selection.set(node, { from: Math.max(0, window.from - 1), to: Math.max(0, window.to - 1) })
    }
  }
  if (/^H[1-6]$/.test(tag)) return { kind: 'heading', level: Number(tag[1]), children: kids }
  if (tag === 'A') {
    if (el.hasAttribute('data-footnote-ref')) return { kind: 'inline', children: kids }
    return { kind: 'link', url: el.getAttribute('href') ?? '', title: el.getAttribute('data-copy-title') ?? undefined, children: kids }
  }
  if (tag === 'UL' || tag === 'OL') return { kind: 'list', start: tag === 'OL' ? (el as HTMLOListElement).start : null, children: kids }
  if (tag === 'LI') {
    const input = el.querySelector<HTMLInputElement>(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]')
    const node: CopyNode = { kind: 'item', children: kids, checked: input?.checked }
    if (reader.range && containsContents(reader.range, el)) reader.selection.set(node, { from: 0, to: 0 })
    return node
  }
  const kinds: Record<string, 'paragraph' | 'strong' | 'em' | 'strike' | 'quote'> = {
    P: 'paragraph', STRONG: 'strong', EM: 'em', DEL: 'strike', BLOCKQUOTE: 'quote'
  }
  return { kind: kinds[tag] ?? (flow ? 'flow' : 'inline'), children: kids }
}

export function collectSelection(range: Range, root: Element): { sections: CopySection[]; selection: CopySelection } {
  const reader: Reader = { range, selection: new Map() }
  const sections: CopySection[] = []
  let current: Element | null = null
  const units = root.querySelectorAll('.md[data-block-key], .transcript-image, .tool-call, .tool-result')
  for (const el of Array.from(units)) {
    if (!intersects(range, el)) continue
    let node: CopyNode | null
    if (el.matches('.tool-call, .tool-result')) {
      const run = el.closest('details.tool-run')
      if (!(run instanceof HTMLDetailsElement) || !run.open) continue
      const pre = el.querySelector('pre.tool-json, pre.tool-result-text')
      if (!pre) continue
      const full = visibleText(pre)
      const value = full.slice(0, displayedLength(pre, full.length))
      node = selectLeaf({ kind: 'tool', value, label: el.querySelector('.tool-name')?.textContent ?? 'Tool',
        lang: pre.classList.contains('tool-json') ? 'json' : undefined }, pre, reader, value.length)
    } else node = readElement(el, reader)
    if (!node) continue
    const article = el.closest('article.message')
    if (article !== current || sections.length === 0) {
      current = article
      sections.push({ label: article?.getAttribute('data-speaker') ?? '',
        isSidechain: article?.hasAttribute('data-sidechain') ?? false, nodes: [] })
    }
    sections[sections.length - 1].nodes.push(node)
  }
  return { sections, selection: reader.selection }
}
export function copySelection(range: Range, root: Element, mode: CopyMode): string {
  const { sections, selection } = collectSelection(range, root)
  return assembleCopy(sections, { mode, intent: 'selection', selection })
}
export function tableRows(table: HTMLTableElement | null): string[][] {
  if (!table) return []
  return Array.from(table.rows).map(row => Array.from(row.cells).map(cell =>
    serializeCopy([{ kind: 'cell', children: children(cell, { selection: new Map() }) }], { mode: 'plain', intent: 'complete' })
  ))
}
export function rangeOver(el: Element): Range {
  const range = document.createRange()
  range.selectNodeContents(el)
  return range
}
