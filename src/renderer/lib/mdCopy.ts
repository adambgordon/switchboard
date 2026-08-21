/**
 * Source-offset mapping for the Formatted view's "copy as Markdown" selection handling.
 *
 * The Formatted view renders each text block through ReactMarkdown, and a rehype pass stamps every
 * rendered element with its `data-s` / `data-e` — the offsets of that element's markdown inside the
 * block's original source (the same `node.position` offsets the table copy button already slices by).
 * Given those annotations, a selection maps back to a CONTIGUOUS source span per block: rendered order
 * matches source order, so a contiguous DOM range is a contiguous slice of the source.
 *
 * This module is the pure half — it never touches the DOM. The caller (`mdCopyDom.ts`) reads the
 * annotated tree into a plain `SrcNode` and hands offsets in RENDERED-TEXT space; everything here maps
 * those to SOURCE space. Keeping it DOM-free is what lets the test suite import it under the node
 * tsconfig (same split as `theme.ts` / `themeDom.ts`).
 *
 * The governing principle is REFUSE RATHER THAN GUESS: every exact mapping is proven (by a length or
 * substring check) before it's used, and anything unprovable falls back to the enclosing element's own
 * `s` / `e`. That fallback always widens the slice, never narrows it — so a copy can include a little
 * more than was highlighted, but never silently drops highlighted text or emits a mis-sliced fragment.
 */

/** One annotated element, flattened out of the DOM. */
export interface SrcNode {
  /** Source offset where this element's markdown begins (its `data-s`). */
  s: number
  /** Source offset just past this element's markdown (its `data-e`). */
  e: number
  /** The element's rendered text, with injected chrome excluded. Empty for `<br>`; `kind` supplies it. */
  text: string
  /** Nearest annotated descendants, in document order. */
  children: SrcChild[]
  /** A fenced code block. Inverts the widen rule — see `codeWiden`. */
  fenced?: boolean
  /**
   * An inline code span. Takes the same inverted widen rule as a fence, but NOT the fence's exemption
   * from `unpaired` — see the note there for why the two must differ.
   */
  codeSpan?: boolean
  /** Structural meaning that changes how source-only characters project into rendered text. */
  kind?: 'blockquote' | 'list-item' | 'break'
}

export interface SrcChild {
  /** Offset into the PARENT's `text` at which this child's `text` starts. */
  at: number
  node: SrcNode
}

/** Which end of the selection a boundary is — decides which way an unprovable mapping widens. */
export type Side = 'start' | 'end'

export interface SpanContext {
  /** The selection begins in an earlier markdown source unit. */
  startsBefore: boolean
  /** The selection ends in a later markdown source unit. */
  endsAfter: boolean
}

/* Both edge tests take offsets that may fall OUTSIDE the text — a boundary belonging to a sibling is
 * expressed in this node's coordinates and lands negative or past the end. Clamping is essential, not
 * defensive: `'bcd'.slice(0, -2)` is `'b'`, so an unclamped atStart reads "the selection starts before
 * this run" as "it starts two characters in" and refuses to pair up the run's delimiters. */

/** Is everything before `off` whitespace? (Leading-edge test, tolerant of what a drag can't reach.) */
const atStart = (text: string, off: number): boolean =>
  text.slice(0, Math.max(0, off)).trim() === ''
/** Is everything from `off` on whitespace? A fence's rendered text ends in a newline no drag covers. */
const atEnd = (text: string, off: number): boolean => text.slice(Math.max(0, off)).trim() === ''

/** remark-rehype represents a hard break as an empty `<br>` followed by a generated newline text node. */
const renderedText = (node: SrcNode): string => (node.kind === 'break' ? '\n' : node.text)

interface ContainerOwner {
  node: SrcNode
  kind: 'blockquote' | 'list-item'
  s: number
  e: number
  t0: number
  t1: number
  depth: number
  order: number
  indent: number
}

interface SourcePrefix {
  s: number
  e: number
  owner: ContainerOwner
}

interface LocatedText {
  at: number
  length: number
}

interface SourceProjection {
  text: string
  positions: number[]
  prefixes: SourcePrefix[]
  leaves: WeakMap<SrcNode, LocatedText | null>
  gaps: WeakMap<SrcNode, Map<number, LocatedText | null>>
}

function collectOwners(
  node: SrcNode,
  t0: number,
  depth: number,
  owners: ContainerOwner[],
  fenced: SrcRange[]
): void {
  const text = renderedText(node)
  // `fenced` rather than `isCode`: this list suppresses blockquote / list continuation-prefix stripping
  // inside a block whose lines are literal. A code span has no lines of its own, so adding one here
  // would suppress prefix cuts that the surrounding container genuinely needs.
  if (node.fenced) fenced.push({ s: node.s, e: node.e })
  if (node.kind === 'blockquote' || node.kind === 'list-item') {
    owners.push({
      node,
      kind: node.kind,
      s: node.s,
      e: node.e,
      t0,
      t1: t0 + text.length,
      depth,
      order: owners.length,
      indent: 0
    })
    depth += 1
  }
  for (const child of node.children) {
    collectOwners(child.node, t0 + child.at, depth, owners, fenced)
  }
}

function quoteMarkerEnd(source: string, at: number, lineEnd: number): number | null {
  let p = at
  while (p < lineEnd && p - at < 3 && source[p] === ' ') p += 1
  if (source[p] !== '>') return null
  p += 1
  if (p < lineEnd && (source[p] === ' ' || source[p] === '\t')) p += 1
  return p
}

function listMarkerEnd(source: string, at: number, lineEnd: number): number | null {
  const match = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(source.slice(at, lineEnd))
  return match ? at + match[0].length : null
}

const isLineSpace = (char: string): boolean => char === ' ' || char === '\t'

function lineSpaceEnd(source: string, at: number, lineEnd: number): number {
  let end = at
  while (end < lineEnd && isLineSpace(source[end])) end += 1
  return end
}

const startsOnLine = (owner: ContainerOwner, lineStart: number, lineEnd: number): boolean =>
  owner.s >= lineStart && owner.s < lineEnd

function addPrefix(out: SourcePrefix[], s: number, e: number, owner: ContainerOwner): void {
  if (e > s) out.push({ s, e, owner })
}

function consumePrefixes(
  source: string,
  lineStart: number,
  lineEnd: number,
  active: ContainerOwner[],
  out: SourcePrefix[]
): number {
  let cursor = lineStart
  for (let i = 0; i < active.length; i += 1) {
    const owner = active[i]
    if (owner.kind === 'blockquote') {
      const markerEnd = quoteMarkerEnd(source, cursor, lineEnd)
      if (
        markerEnd === null ||
        (startsOnLine(owner, lineStart, lineEnd) && source.indexOf('>', cursor) !== owner.s)
      ) {
        continue
      }
      addPrefix(out, cursor, markerEnd, owner)
      cursor = markerEnd
      continue
    }
    if (startsOnLine(owner, lineStart, lineEnd)) {
      if (owner.s < cursor || lineSpaceEnd(source, cursor, owner.s) !== owner.s) continue
      const parent = active[i - 1]
      if (parent) addPrefix(out, cursor, owner.s, parent)
      cursor = owner.s
      const markerEnd = listMarkerEnd(source, cursor, lineEnd)
      if (markerEnd === null) continue
      owner.indent = markerEnd - cursor
      addPrefix(out, cursor, markerEnd, owner)
      cursor = markerEnd
      continue
    }

    const whitespaceEnd = lineSpaceEnd(source, cursor, lineEnd)
    const nextStart = active
      .slice(i + 1)
      .find((candidate) => startsOnLine(candidate, lineStart, lineEnd))?.s
    const limit = nextStart === undefined ? whitespaceEnd : Math.min(whitespaceEnd, nextStart)
    const take = Math.min(owner.indent, Math.max(0, limit - cursor))
    addPrefix(out, cursor, cursor + take, owner)
    cursor += take
  }
  return cursor
}

/**
 * Find only source prefixes whose ownership is proved by the annotated container tree. The scan is
 * linear in source lines and container depth; no rendered-text endpoint performs its own line walk.
 */
function sourcePrefixes(
  source: string,
  root: SrcNode,
  owners: ContainerOwner[],
  fenced: SrcRange[]
): SourcePrefix[] {
  const out: SourcePrefix[] = []
  const starts = [...owners].sort((a, b) => a.s - b.s || a.depth - b.depth || a.order - b.order)
  const fencedSpans = [...fenced].sort((a, b) => a.s - b.s || a.e - b.e)
  const active: ContainerOwner[] = []
  let nextOwner = 0
  let nextFence = 0
  let lineStart = root.s

  while (lineStart < root.e) {
    const newline = source.indexOf('\n', lineStart)
    const lineEnd = newline >= 0 && newline < root.e ? newline : root.e
    for (let i = active.length - 1; i >= 0; i -= 1) {
      if (active[i].e <= lineStart) active.splice(i, 1)
    }
    while (nextOwner < starts.length && starts[nextOwner].s < lineEnd) {
      const owner = starts[nextOwner]
      if (owner.e > lineStart) active.push(owner)
      nextOwner += 1
    }
    active.sort((a, b) => a.depth - b.depth || a.order - b.order)

    const cursor = consumePrefixes(source, lineStart, lineEnd, active, out)
    while (nextFence < fencedSpans.length && fencedSpans[nextFence].e <= cursor) nextFence += 1
    const insideFence =
      nextFence < fencedSpans.length &&
      fencedSpans[nextFence].s <= cursor &&
      cursor < fencedSpans[nextFence].e
    const deepest = active[active.length - 1]
    if (deepest && !insideFence) addPrefix(out, cursor, lineSpaceEnd(source, cursor, lineEnd), deepest)

    if (lineEnd === root.e) break
    lineStart = lineEnd + 1
  }
  return out
}

function buildProjection(source: string, root: SrcNode): SourceProjection {
  const owners: ContainerOwner[] = []
  const fenced: SrcRange[] = []
  collectOwners(root, 0, 0, owners, fenced)
  if (owners.length === 0) {
    return {
      text: '',
      positions: [],
      prefixes: [],
      leaves: new WeakMap(),
      gaps: new WeakMap()
    }
  }
  const prefixes = sourcePrefixes(source, root, owners, fenced)
  const text: string[] = []
  const positions: number[] = []
  let prefixIndex = 0
  let sourceAt = root.s
  while (sourceAt < root.e) {
    const prefix = prefixes[prefixIndex]
    if (prefix && prefix.s === sourceAt) {
      sourceAt = prefix.e
      prefixIndex += 1
      continue
    }
    text.push(source[sourceAt])
    positions.push(sourceAt)
    sourceAt += 1
  }
  return {
    text: text.join(''),
    positions,
    prefixes,
    leaves: new WeakMap(),
    gaps: new WeakMap()
  }
}

function lowerBound(values: number[], target: number): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (values[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function hasPrefix(projection: SourceProjection, s: number, e: number): boolean {
  let lo = 0
  let hi = projection.prefixes.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if (projection.prefixes[mid].e <= s) lo = mid + 1
    else hi = mid
  }
  return lo < projection.prefixes.length && projection.prefixes[lo].s < e
}

function locateText(
  projection: SourceProjection,
  s: number,
  e: number,
  text: string
): LocatedText | null {
  const p0 = lowerBound(projection.positions, s)
  const p1 = lowerBound(projection.positions, e)
  const at = contentStart(projection.text.slice(p0, p1), text)
  return at === null ? null : { at: p0 + at, length: text.length }
}

function mapLocated(
  projection: SourceProjection,
  located: LocatedText,
  off: number,
  side: Side
): number | null {
  if (located.length === 0) return null
  const clamped = Math.max(0, Math.min(off, located.length))
  if (clamped === 0) return projection.positions[located.at]
  if (clamped === located.length) {
    return projection.positions[located.at + located.length - 1] + 1
  }
  return side === 'start'
    ? projection.positions[located.at + clamped]
    : projection.positions[located.at + clamped - 1] + 1
}

function ownerFullyCovered(owner: ContainerOwner, from: number, to: number): boolean {
  const text = renderedText(owner.node)
  return atStart(text, from - owner.t0) && atEnd(text, to - owner.t0)
}

/** A fenced block or an inline code span — the two constructs `codeWiden` governs. */
const isCode = (node: SrcNode): boolean => node.fenced === true || node.codeSpan === true

/**
 * Code delimiters INVERT the widen rule: everything else earns its delimiters by being fully covered,
 * code earns them only when the selection reaches outside the run.
 *
 * Code markers are the ones people routinely want left behind. Grabbing a command out of a transcript to
 * run it, or a URL to open it, you want the payload — not markup you then delete. But once a selection
 * spans the run AND its surroundings, the markers have to come along: they sit between the two ends in
 * the source, so a slice that omitted them would splice code into prose.
 *
 * This holds for ```` ``` ```` and for a single-backtick span alike. The distinction that matters is not
 * fence-versus-span, it is confined-versus-crossing: a selection that stops at the run's edges is asking
 * for the code, and one that runs past them is asking for the prose that contains it.
 */
const codeWiden = (kid: SrcChild, side: Side, other: number): boolean =>
  side === 'start' ? other > kid.at + renderedText(kid.node).length : other < kid.at

/**
 * Does this node contribute nothing but code? Then it has no delimiters of its OWN to widen to —
 * widening would emit the markers the rule above just declined. Recurses so a wrapper of a wrapper is
 * still recognized (a message whose entire body is one code block, or a bullet holding one code span).
 */
function onlyCode(node: SrcNode): boolean {
  if (isCode(node)) return true
  const [only] = node.children
  return (
    node.children.length === 1 &&
    only.at === 0 &&
    renderedText(only.node).length === renderedText(node).length &&
    onlyCode(only.node)
  )
}

/**
 * Map a selection — both boundaries at once — from rendered-text offsets to a source span.
 *
 * WIDENING IS ALL-OR-NOTHING. An element's own delimiters are added only when BOTH ends of the
 * selection cover that element: select all of a heading and you get `## Title`, select all of a bold run
 * and you get `**bold**`. Cover only part of it and you get bare content — which is what keeps a partial
 * selection from coming back with an opening delimiter and no closing one.
 *
 * CODE INVERTS THAT (`codeWiden`): a fence and a backtick span hand back bare content on full coverage,
 * and their markers travel only once the selection reaches past the run.
 *
 * Both ends have to be resolved together for that: a single boundary can't tell whether it's one edge
 * of a full-element selection or one edge of a partial one.
 *
 * A delimiter that falls inside the span but whose PARTNER doesn't is then cut back out by `unpaired`,
 * which is why the result can be several ranges rather than one. So cutting through a bold run yields
 * `ld text here` — the closing `**` was in range, but emitting it alone would open a new run on paste.
 */
export function resolveSpan(
  source: string,
  node: SrcNode,
  from: number,
  to: number,
  context: SpanContext
): SrcRange[] {
  const text = renderedText(node)
  const t0 = Math.max(0, Math.min(from, text.length))
  const t1 = Math.max(t0, Math.min(to, text.length))
  const coversNode = atStart(text, t0) && atEnd(text, t1)
  const codeOnly = onlyCode(node)
  // A code-only unit has no local prose offset that can prove the selection left it. The DOM range
  // supplies that missing context; both coverage checks keep a partial cross-unit selection bare. This
  // is what keeps a turn or whole-conversation copy — which always arrives from an outer range — fully
  // marked up, even where the unit is a lone code span that a confined drag would hand back bare.
  if (codeOnly && (context.startsBefore || context.endsAfter) && coversNode) {
    return [{ s: node.s, e: node.e }]
  }
  // Whole-block copies already have an exact annotated span; the projection is only needed to locate
  // a boundary inside the block. This keeps turn/conversation copy on its original constant-time path.
  if (!codeOnly && coversNode) return [{ s: node.s, e: node.e }]
  const projection = buildProjection(source, node)
  const a = resolvePoint(source, node, t0, 'start', t1, projection)
  const b = resolvePoint(source, node, t1, 'end', t0, projection)
  const delimiterCuts = normalizeRanges([
    ...unpaired(source, node, t0, 'start', projection),
    ...unpaired(source, node, t1, 'end', projection)
  ])
  const prefixCuts = projection.prefixes
    .filter((prefix) => !ownerFullyCovered(prefix.owner, t0, t1))
    .map(({ s, e }) => ({ s, e }))
  const cuts = mergeOrderedRanges(prefixCuts, delimiterCuts)
  return subtract({ s: Math.min(a, b), e: Math.max(a, b) }, cuts)
}

/** A half-open source range. A copy is normally one of these, but see `unpaired`. */
export interface SrcRange {
  s: number
  e: number
}

/**
 * Find delimiters that would land in the slice WITHOUT their partner, so the caller can excise them.
 *
 * A selection cutting into `**bold text**` and running on into the prose after it produces a contiguous
 * source slice containing the closing `**` and not the opening one. That isn't merely untidy — pasted
 * anywhere that renders markdown, the orphan delimiter opens a NEW run and corrupts everything
 * downstream of it. So a partially-covered run gives up its markup entirely: you get the characters you
 * highlighted, unstyled, which is the only honest rendering of half a styled run.
 *
 * Walks the same descent as `mapContainer`, so nesting is handled — a boundary inside inline code inside
 * a bold run orphans both, and both are cut.
 *
 * FENCES ARE EXEMPT HERE AND CODE SPANS ARE NOT, even though `codeWiden` governs both. A fence is a block,
 * so a boundary inside one and a boundary in neighboring prose can never share a source unit — the split
 * gives each its own `resolveSpan`, and no single span can hold half a fence. A code span sits inside a
 * paragraph, so exactly that shape occurs: start mid-span, end in the prose after it, and the closing
 * backtick falls inside the resolved span with its partner outside. Exempting code spans would emit it.
 */
function unpaired(
  source: string,
  node: SrcNode,
  off: number,
  side: Side,
  projection: SourceProjection
): SrcRange[] {
  const out: SrcRange[] = []
  let cur = node
  let here = off
  while (cur.children.length > 0) {
    // Only a boundary STRICTLY inside a child orphans anything; on an edge, the widen rules apply.
    const kid = cur.children.find(
      (k) => here > k.at && here < k.at + renderedText(k.node).length
    )
    if (!kid) break
    // No "does the selection reach past this run" test is needed: if it doesn't, the delimiter lies
    // outside the resolved span and `subtract` finds nothing to remove. Deliberately `fenced` and not
    // `isCode` — see the fence/code-span asymmetry in this function's doc comment.
    if (!kid.node.fenced) {
      const cut = orphanDelimiter(source, kid.node, side, projection)
      if (cut) out.push(cut)
    }
    here -= kid.at
    cur = kid.node
  }
  return out
}

/**
 * The delimiter left partnerless by a boundary on `side`: the closing one for a start, opening for an end.
 *
 * Located by asking the mapper where the node's CONTENT begins and ends, rather than by searching for the
 * rendered text inside the source. A substring search only works for a leaf: `**a `b` c**` contains its
 * child's backticks, so its rendered `a b c` appears nowhere in its own source and the search refuses.
 * `other` is set as though the whole node were selected, which is the right frame for "where does this
 * node's content start" — otherwise a run beginning with a nested run would measure to the inner
 * delimiter and cut too much.
 */
function orphanDelimiter(
  source: string,
  node: SrcNode,
  side: Side,
  projection: SourceProjection
): SrcRange | null {
  const text = renderedText(node)
  if (side === 'start') {
    const contentEnd = mapExact(source, node, text.length, 'end', 0, projection)
    return contentEnd === null ? null : { s: contentEnd, e: node.e }
  }
  const contentBegin = mapExact(source, node, 0, 'start', text.length, projection)
  return contentBegin === null ? null : { s: node.s, e: contentBegin }
}

function appendRange(ranges: SrcRange[], range: SrcRange): void {
  if (range.e <= range.s) return
  const last = ranges[ranges.length - 1]
  if (last && range.s <= last.e) {
    last.e = Math.max(last.e, range.e)
  } else {
    ranges.push({ ...range })
  }
}

function normalizeRanges(ranges: SrcRange[]): SrcRange[] {
  const out: SrcRange[] = []
  for (const range of [...ranges].sort((a, b) => a.s - b.s || a.e - b.e)) {
    appendRange(out, range)
  }
  return out
}

function mergeOrderedRanges(left: SrcRange[], right: SrcRange[]): SrcRange[] {
  const out: SrcRange[] = []
  let i = 0
  let j = 0
  while (i < left.length || j < right.length) {
    if (j >= right.length || (i < left.length && left[i].s <= right[j].s)) {
      appendRange(out, left[i])
      i += 1
    } else {
      appendRange(out, right[j])
      j += 1
    }
  }
  return out
}

/** Remove ordered, non-overlapping `cuts` from `range` in one pass. */
function subtract(range: SrcRange, cuts: SrcRange[]): SrcRange[] {
  const pieces: SrcRange[] = []
  let at = range.s
  for (const cut of cuts) {
    if (cut.e <= at) continue
    if (cut.s >= range.e) break
    if (cut.s > at) pieces.push({ s: at, e: Math.min(cut.s, range.e) })
    at = Math.max(at, cut.e)
    if (at >= range.e) break
  }
  if (at < range.e) pieces.push({ s: at, e: range.e })
  return pieces
}

function resolvePoint(
  source: string,
  node: SrcNode,
  off: number,
  side: Side,
  other: number,
  projection: SourceProjection
): number {
  const text = renderedText(node)
  // The whole node is covered — take its own span, delimiters and all. Skipped for a node that is
  // nothing but code, whose delimiters are governed by codeWiden instead.
  if (!onlyCode(node)) {
    if (side === 'start' && atStart(text, off) && atEnd(text, other)) return node.s
    if (side === 'end' && atEnd(text, off) && atStart(text, other)) return node.e
  }
  const exact = mapExact(source, node, off, side, other, projection)
  return exact ?? (side === 'start' ? node.s : node.e)
}

function mapExact(
  source: string,
  node: SrcNode,
  off: number,
  side: Side,
  other: number,
  projection: SourceProjection
): number | null {
  return node.children.length > 0
    ? mapContainer(source, node, off, side, other, projection)
    : mapLeaf(source, node, off, side, projection)
}

/**
 * A container maps by locating `off` in one of its alternating regions — a plain-text gap, or an
 * annotated child — and delegating.
 *
 * Two distinct things can happen at a child's text edge, and conflating them was the partial-fence bug:
 *   • STOPPING at an edge adds nothing, so it's unconditional. Ending where a child begins is `kid.s`;
 *     starting where it ends is `kid.e`. No delimiter joins the slice either way.
 *   • WIDENING over the child's own delimiters is conditional — it only holds when the other end of
 *     the selection covers the child too, so `**` and ```` ``` ```` are never emitted half a pair.
 */
function mapContainer(
  source: string,
  node: SrcNode,
  off: number,
  side: Side,
  other: number,
  projection: SourceProjection
): number | null {
  const kids = node.children
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i]
    const kidText = renderedText(kid.node)
    const kidEnd = kid.at + kidText.length
    if (off < kid.at) return mapGap(source, node, i, off, side, projection)
    if (off > kidEnd) continue
    const here = off - kid.at
    const far = other - kid.at
    if (off === kid.at && side === 'end') return kid.node.s
    if (off === kidEnd && side === 'start') return kid.node.e
    // Widening over the child's own delimiters. Everything qualifies by the other end covering the
    // child; code qualifies by the other end reaching PAST it (see codeWiden). Either way the
    // boundary itself must sit on the child's edge — a boundary strictly inside a run never widens,
    // and that run's other delimiter is cut back out afterwards by `unpaired`.
    const qualifies = isCode(kid.node)
      ? codeWiden(kid, side, other)
      : side === 'start'
        ? atEnd(kidText, far)
        : atStart(kidText, far)
    if (side === 'start' && atStart(kidText, here) && qualifies) return kid.node.s
    if (side === 'end' && atEnd(kidText, here) && qualifies) return kid.node.e
    // Inside the child (or on its trailing edge without qualifying to widen). Ending exactly at the
    // run's end after starting INSIDE it maps to the content end, not past the closing delimiter —
    // `old text` out of `**bold text**`, never `old text**`. An unpaired delimiter here would be the
    // same defect the widen rule above exists to prevent.
    // A child that can't prove its mapping falls back to ITS own span, not the whole block's: an
    // ambiguous link should widen to the link, not swallow every paragraph around it.
    const inner = mapExact(source, kid.node, here, side, far, projection)
    return inner ?? (side === 'start' ? kid.node.s : kid.node.e)
  }
  return mapGap(source, node, kids.length, off, side, projection)
}

/**
 * Map an offset inside gap `i` — the plain-text run before child `i` (or after the last child, when
 * `i === children.length`). The gap's source position is anchored to the neighboring child's span, then
 * VERIFIED by comparing the two strings; an escape (`\*`), an entity, or any other place where rendered
 * text and source diverge fails that check and returns null so the caller widens instead.
 */
function mapGap(
  source: string,
  node: SrcNode,
  i: number,
  off: number,
  side: Side,
  projection: SourceProjection
): number | null {
  const kids = node.children
  if (kids.length === 0) return null
  const prev = i > 0 ? kids[i - 1] : null
  const next = i < kids.length ? kids[i] : null
  const text = renderedText(node)
  const t0 = prev ? prev.at + renderedText(prev.node).length : 0
  const t1 = next ? next.at : text.length
  if (off < t0 || off > t1) return null
  const sourceStart = prev ? prev.node.e : node.s
  const sourceEnd = next ? next.node.s : node.e
  if (hasPrefix(projection, sourceStart, sourceEnd)) {
    let gaps = projection.gaps.get(node)
    if (!gaps) {
      gaps = new Map()
      projection.gaps.set(node, gaps)
    }
    let located = gaps.get(i)
    if (located === undefined) {
      located = locateText(projection, sourceStart, sourceEnd, text.slice(t0, t1))
      gaps.set(i, located)
    }
    return located ? mapLocated(projection, located, off - t0, side) : null
  }
  // Anchor to the preceding child's end where there is one, else back off the following child's start.
  const srcAt = prev ? prev.node.e : (next as SrcChild).node.s - (t1 - t0)
  if (srcAt < 0) return null
  if (source.slice(srcAt, srcAt + (t1 - t0)) !== text.slice(t0, t1)) return null
  return srcAt + (off - t0)
}

/**
 * Map an offset inside a leaf — an element with no annotated descendants, so its rendered text is one
 * run sitting somewhere inside its source span. `contentStart` finds where, or refuses.
 */
function mapLeaf(
  source: string,
  node: SrcNode,
  off: number,
  side: Side,
  projection: SourceProjection
): number | null {
  const text = renderedText(node)
  if (hasPrefix(projection, node.s, node.e)) {
    let located = projection.leaves.get(node)
    if (located === undefined) {
      located = locateText(projection, node.s, node.e, text)
      projection.leaves.set(node, located)
    }
    return located ? mapLocated(projection, located, off, side) : null
  }
  const src = source.slice(node.s, node.e)
  if (src === text) return node.s + off
  const cs = contentStart(src, text)
  return cs === null ? null : node.s + cs + off
}

/**
 * Where `text` begins inside `src`, but ONLY when that position is unambiguous.
 *
 * One uniqueness test covers every wrapper shape at once — `**bold**`, `*em*`, `` `code` ``, `~~strike~~`,
 * a ```` ```lang ```` fence, even `[label](url)` when the label doesn't recur in the URL — without
 * enumerating delimiters or parsing. When the text appears more than once (`[link](http://link.com)`)
 * the position genuinely can't be proven from a substring search, so this refuses and the caller widens
 * to the whole element. Refusing costs a slightly larger slice; guessing would cost a wrong one.
 */
function contentStart(src: string, text: string): number | null {
  if (text.length === 0) return null
  const i = src.indexOf(text)
  if (i < 0) return null
  if (src.indexOf(text, i + 1) >= 0) return null
  return i
}

/**
 * Wrap plain text — a tool result, a JSON input — as a fenced code block.
 *
 * The fence grows past the longest backtick run inside the body. Tool output frequently contains
 * ```` ``` ```` (an agent quoting a code block back at you), which with a fixed three-backtick fence
 * would close the block early and spill the remainder into the document as prose.
 */
export function fence(body: string, lang = ''): string {
  const runs = body.match(/`+/g)
  const longest = runs ? runs.reduce((n, run) => Math.max(n, run.length), 0) : 0
  const bar = '`'.repeat(Math.max(3, longest + 1))
  return `${bar}${lang}\n${body.replace(/\s+$/, '')}\n${bar}`
}

/** One speaker's contribution to a copy — the prose pulled from a single transcript section. */
export interface CopySection {
  /** 'You' | the agent's assistant label. */
  label: string
  isSidechain: boolean
  /** Markdown fragments in document order; blank entries are dropped. */
  parts: string[]
}

/** Tabs carry table columns in plain mode, so trim the surrounding whitespace without consuming them. */
export const trimPlainEdges = (text: string): string => text.replace(/^[^\S\t]+|[^\S\t]+$/g, '')

/**
 * Join per-section markdown into the final clipboard text, in the same shape the footer's "Copy entire
 * conversation" produces: a bold speaker label over each body, sections divided by a horizontal rule.
 *
 * A selection confined to ONE section comes back bare (no label, no rule) — attribution only earns its
 * space once there's more than one voice to tell apart. `conversationMarkdown` opts out via `alwaysLabel`
 * because a whole-conversation export is a document, where a lone speaker still wants naming.
 *
 * `plain` drops the markdown from the SCAFFOLDING only — `You:` rather than `**You:**`. Attribution is
 * structure, not styling, so it survives into a plain-text copy; the rule between sections reads fine
 * unstyled too.
 */
export function assembleCopy(sections: CopySection[], alwaysLabel = false, plain = false): string {
  const kept = sections
    .map((sec) => ({
      label: sec.isSidechain ? `${sec.label} (Sub-agent)` : sec.label,
      body: sec.parts
        .map((p) => (plain ? trimPlainEdges(p) : p.trim()))
        .filter(Boolean)
        .join('\n\n')
    }))
    .filter((sec) => sec.body)
  if (kept.length === 0) return ''
  if (kept.length === 1 && !alwaysLabel) return kept[0].body
  const head = (label: string): string => (plain ? `${label}:` : `**${label}:**`)
  return kept.map((sec) => `${head(sec.label)}\n\n${sec.body}`).join('\n\n---\n\n')
}
