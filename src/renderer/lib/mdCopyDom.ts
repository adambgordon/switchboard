import { fence, resolveSpan, trimPlainEdges, type CopySection, type SrcNode } from './mdCopy'
import { rowsToPlainText } from './clipboard'

/**
 * The DOM half of the Formatted view's copy pipeline — turns a `Range` into the per-speaker sections
 * `assembleCopy` joins. Deliberately thin: every non-obvious mapping decision lives in the pure
 * `mdCopy.ts`, so this stays the part that only knows how to read a DOM (the `themeDom.ts` split).
 *
 * ONE ENGINE, THREE CALLERS. The ⌘C handler passes the live selection; the per-turn copy button passes a
 * range over its own section; both pass either mode. Sharing the traversal is what guarantees a button
 * and a hand-drag over the same content produce identical bytes — the alternative (a parallel
 * message-walking implementation for the button) drifted the moment tool I/O became conditional.
 *
 * Three things are excluded from the text walk, and all three are correctness rather than taste:
 *   • `[data-md-skip]` — chrome the renderer injects with no source behind it (the fenced-code language
 *     caption). It sits inside the annotated subtree but not inside the markdown, so counting it would
 *     shift every source offset after it.
 *   • `<button>` — the hover copy affordances. They carry no text today; rejecting them means a future
 *     one with a label can't silently corrupt the offsets.
 *   • A COLLAPSED tool run. Expansion is the gate on whether tool I/O is copyable at all, so a closed
 *     `<details>` contributes nothing even though its content is in the DOM.
 */

export type CopyMode = 'markdown' | 'plain'

/** Rendered subtrees that exist in the DOM but not in the markdown source. */
function isSkipped(el: Element): boolean {
  return el.hasAttribute('data-md-skip') || el.tagName === 'BUTTON'
}

/** The nearest annotated descendants of `el` — descent stops at each one it finds. */
function annotatedChildren(el: Element): Element[] {
  const out: Element[] = []
  const visit = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      if (isSkipped(child)) continue
      if (child.hasAttribute('data-s')) out.push(child)
      else visit(child)
    }
  }
  visit(el)
  return out
}

function intAttr(el: Element, name: string): number {
  const n = Number.parseInt(el.getAttribute(name) ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * One linear pass over `el`'s text, recording where each of `kids` starts. Done in a single walk (rather
 * than one re-scan per child) so describing a block stays O(nodes) — a selection can span a lot of them.
 */
function scan(el: Element, kids: Element[]): { text: string; offsets: number[] } {
  const index = new Map<Element, number>()
  kids.forEach((k, i) => index.set(k, i))
  const offsets = new Array<number>(kids.length).fill(0)
  let acc = ''
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      acc += n.nodeValue ?? ''
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const child = n as Element
    if (isSkipped(child)) return
    const i = index.get(child)
    if (i !== undefined) offsets[i] = acc.length
    for (const c of Array.from(child.childNodes)) walk(c)
  }
  for (const c of Array.from(el.childNodes)) walk(c)
  return { text: acc, offsets }
}

/** The text a rendered element contributes to the clipboard, with renderer-only chrome excluded. */
const visibleText = (el: Element): string => scan(el, []).text

/** Read an annotated element (and its annotated descendants) into the pure mapper's shape.
 *  `<pre>` is flagged so the mapper can invert its widen rule — inline `<code>` is NOT a `<pre>`, so it
 *  keeps the ordinary behaviour and a backtick pair travels only on a full-coverage selection.
 *  Line containers and `<br>` keep their tag semantics because their source carries invisible syntax. */
function describe(el: Element): SrcNode {
  const kids = annotatedChildren(el)
  const { text, offsets } = scan(el, kids)
  const kind =
    el.tagName === 'BLOCKQUOTE'
      ? 'blockquote'
      : el.tagName === 'LI'
        ? 'list-item'
        : el.tagName === 'BR'
          ? 'break'
          : undefined
  return {
    s: intAttr(el, 'data-s'),
    e: intAttr(el, 'data-e'),
    text,
    children: kids.map((k, i) => ({ at: offsets[i], node: describe(k) })),
    fenced: el.tagName === 'PRE',
    kind
  }
}

/**
 * "Is the boundary at or before this text node?" — needed because a `Range` boundary can be expressed as
 * an ELEMENT plus a child index, which no text node will ever match by identity.
 */
function makeProbe(container: Node, offset: number): (n: Node) => boolean {
  const r = document.createRange()
  try {
    r.setStart(container, offset)
    r.setEnd(container, offset)
  } catch {
    return () => false
  }
  return (n) => {
    try {
      return r.comparePoint(n, 0) >= 0
    } catch {
      return false
    }
  }
}

/**
 * Convert a `Range` boundary into an offset in `root`'s rendered text. Walks the same way `scan` does —
 * they must agree exactly, or a boundary would be measured against a different string than the one the
 * offsets were built from.
 */
function textOffsetIn(root: Element, container: Node, offset: number): number {
  const probe = makeProbe(container, offset)
  let acc = 0
  let done = false
  const walk = (n: Node): void => {
    if (done) return
    if (n.nodeType === Node.TEXT_NODE) {
      if (n === container) {
        acc += Math.min(offset, n.nodeValue?.length ?? 0)
        done = true
        return
      }
      if (probe(n)) {
        done = true
        return
      }
      acc += n.nodeValue?.length ?? 0
      return
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return
    const el = n as Element
    if (isSkipped(el)) return
    for (const c of Array.from(el.childNodes)) walk(c)
  }
  for (const c of Array.from(root.childNodes)) walk(c)
  return acc
}

/**
 * Move a boundary that landed inside SKIPPED content out to the edge of the element hosting it.
 *
 * A skipped subtree contributes no text, so the walk above cannot locate a boundary inside one — it
 * returns early and the boundary silently resolves to wherever the walk happened to stop. That is
 * reachable by ordinary use: a rendered formula's glyphs are skipped (the LaTeX travels instead, see
 * MathBlock.tsx), so dragging across the formula itself puts both boundaries in skipped content, and
 * the selection collapses to nothing or drops the formula.
 *
 * Snapping to the enclosing ANNOTATED element — its start for the leading edge, its end for the
 * trailing edge — makes any touch of that content select the whole unit, which is the same rule an
 * inline-image chip already follows. Expressed as an element-plus-index boundary, which `makeProbe`
 * handles, so the walk itself needs no new cases.
 */
function snapOutOfSkipped(node: Node, offset: number, edge: 'start' | 'end'): [Node, number] {
  const from = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const skipped = from?.closest('[data-md-skip], button')
  if (!skipped) return [node, offset]
  const host = skipped.closest('[data-s]')
  if (!host) return [node, offset]
  return edge === 'start' ? [host, 0] : [host, host.childNodes.length]
}

/** The rendered-text window the range cuts out of `el`. A boundary outside means the range swept in
 *  from a neighbour, so that edge takes the whole extent. */
function windowIn(
  el: Element,
  range: Range,
  length: number
): { t0: number; t1: number; startsBefore: boolean; endsAfter: boolean } {
  const [startNode, startOffset] = snapOutOfSkipped(range.startContainer, range.startOffset, 'start')
  const [endNode, endOffset] = snapOutOfSkipped(range.endContainer, range.endOffset, 'end')
  const startsBefore = !el.contains(startNode)
  const endsAfter = !el.contains(endNode)
  const t0 = !startsBefore ? textOffsetIn(el, startNode, startOffset) : 0
  const t1 = !endsAfter ? textOffsetIn(el, endNode, endOffset) : length
  return { t0, t1, startsBefore, endsAfter }
}

function intersects(range: Range, el: Element): boolean {
  try {
    return range.intersectsNode(el)
  } catch {
    return false
  }
}

/** Read a rendered table into the same row grid used by its copy button. With a range, the first and
 *  last cells are sliced to their selected text while cells swept between the boundaries stay whole. */
export function tableRows(table: HTMLTableElement | null, range?: Range): string[][] {
  if (!table) return []
  const rows: string[][] = []
  for (const row of Array.from(table.rows)) {
    const cells: string[] = []
    for (const cell of Array.from(row.cells)) {
      if (!range) {
        cells.push(visibleText(cell))
        continue
      }
      if (!intersects(range, cell)) continue
      const full = visibleText(cell)
      const { t0, t1, startsBefore, endsAfter } = windowIn(cell, range, full.length)
      if (t1 > t0) cells.push(full.slice(t0, t1))
      else if (full.length === 0 && startsBefore && endsAfter) cells.push('')
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/** Tool I/O only travels when its run is open — see the exclusion note at the top of the file. */
function inOpenRun(el: Element): boolean {
  const details = el.closest('details.tool-run')
  return details instanceof HTMLDetailsElement ? details.open : false
}

/** The `⚙ Bash` / `↳ Result` label, minus the glyph — `.tool-name` holds the word on its own. */
const toolLabel = (el: Element): string => (el.querySelector('.tool-name')?.textContent ?? '').trim()

/**
 * One tool call or result, rendered for the clipboard as `Bash:` / `Result:` / `Error:` over a fenced
 * body. The `⚙` and `↳` glyphs are deliberately dropped: they're affordances, and they paste as noise
 * into a PR or a doc. Because the label is GENERATED rather than lifted from the DOM, the heads stay
 * non-selectable — you never highlight a glyph and receive different characters.
 */
function toolUnit(el: Element, range: Range, mode: CopyMode): string {
  const pre = el.querySelector('pre.tool-json, pre.tool-result-text')
  if (!pre) return ''
  const full = visibleText(pre)
  const { t0, t1 } = windowIn(pre, range, full.length)
  const body = t1 > t0 ? full.slice(t0, t1) : ''
  if (!body.trim()) return ''
  const label = toolLabel(el) || 'Tool'
  const lang = pre.classList.contains('tool-json') ? 'json' : ''
  return `${label}:\n\n${mode === 'markdown' ? fence(body, lang) : body.replace(/\s+$/, '')}`
}

/** Slice one rendered block, replacing table subtrees with their row-and-column structure. */
function plainSlice(el: Element, range: Range): string {
  if (el.tagName === 'TABLE') return rowsToPlainText(tableRows(el as HTMLTableElement, range))

  const tables = Array.from(el.querySelectorAll<HTMLTableElement>('table'))
  const { text, offsets } = scan(el, tables)
  const { t0, t1 } = windowIn(el, range, text.length)
  if (t1 <= t0) return ''
  if (tables.length === 0) return text.slice(t0, t1)

  const parts: string[] = []
  let cursor = t0
  for (const [i, table] of tables.entries()) {
    const start = offsets[i]
    const end = start + visibleText(table).length
    if (end <= t0 || start >= t1) continue
    if (cursor < start) parts.push(text.slice(cursor, Math.min(start, t1)))
    const replacement = rowsToPlainText(tableRows(table, range))
    if (replacement) parts.push(replacement)
    cursor = Math.max(cursor, Math.min(end, t1))
  }
  if (cursor < t1) parts.push(text.slice(cursor, t1))
  return parts.join('')
}

/**
 * Plain text for a block, with its top-level children separated by a BLANK line.
 *
 * Slicing the block's raw concatenation would separate them by a single `\n` — that's all
 * `mdast-util-to-hast` puts between sibling blocks — where Chromium's own `Selection.toString()` gives
 * `\n\n`. Since this path exists to be the plain-text copy, it has to match what the native copy it
 * replaces would have produced, or paragraphs run together in Slack and email.
 */
function plainUnit(el: Element, range: Range): string {
  const kids = annotatedChildren(el)
  if (kids.length === 0) return plainSlice(el, range)
  const parts: string[] = []
  for (const kid of kids) {
    if (!intersects(range, kid)) continue
    const text = trimPlainEdges(plainSlice(kid, range))
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

/** One prose block: its markdown source sliced to the selection, or the rendered text of that slice. */
function proseUnit(
  el: HTMLElement,
  range: Range,
  sourceFor: (blockKey: string) => string | undefined,
  mode: CopyMode
): string {
  if (mode === 'plain') return plainUnit(el, range)
  const source = sourceFor(el.dataset.blockKey ?? '')
  if (source === undefined) return ''
  const node = describe(el)
  const { t0, t1, startsBefore, endsAfter } = windowIn(el, range, node.text.length)
  if (t1 <= t0) return ''
  // Normally one range; more when an orphaned delimiter had to be cut out of the middle.
  return resolveSpan(source, node, t0, t1, { startsBefore, endsAfter })
    .map((r) => source.slice(r.s, r.e))
    .join('')
}

/**
 * Collect everything `range` touches, grouped into the speaker sections `assembleCopy` joins.
 *
 * Units are visited in document order off one query, so prose and tool output interleave the way they
 * read on screen. Speaker identity is read from the enclosing `article.message`'s own attributes rather
 * than looked up by block key — that way a tool unit, which has no block key, is attributed too.
 */
export function collectSections(
  range: Range,
  root: Element,
  sourceFor: (blockKey: string) => string | undefined,
  mode: CopyMode
): CopySection[] {
  const sections: CopySection[] = []
  let current: Element | null = null
  const units = root.querySelectorAll<HTMLElement>('.md[data-block-key], .tool-call, .tool-result')
  for (const el of Array.from(units)) {
    if (!intersects(range, el)) continue
    const isProse = el.classList.contains('md')
    if (!isProse && !inOpenRun(el)) continue
    const text = isProse ? proseUnit(el, range, sourceFor, mode) : toolUnit(el, range, mode)
    if (!(mode === 'plain' ? trimPlainEdges(text) : text.trim())) continue
    const article = el.closest('article.message')
    if (article !== current || sections.length === 0) {
      current = article
      sections.push({
        label: article?.getAttribute('data-speaker') ?? '',
        isSidechain: article?.hasAttribute('data-sidechain') ?? false,
        parts: []
      })
    }
    sections[sections.length - 1].parts.push(text)
  }
  return sections
}

/** A range covering everything inside `el` — how the per-turn copy button reuses the selection engine. */
export function rangeOver(el: Element): Range {
  const range = document.createRange()
  range.selectNodeContents(el)
  return range
}
