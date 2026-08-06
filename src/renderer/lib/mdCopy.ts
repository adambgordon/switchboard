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
  /** The element's rendered text, with injected chrome (language captions, buttons) excluded. */
  text: string
  /** Nearest annotated descendants, in document order. */
  children: SrcChild[]
  /** A fenced code block. Inverts the widen rule — see `fenceWiden`. */
  fenced?: boolean
}

export interface SrcChild {
  /** Offset into the PARENT's `text` at which this child's `text` starts. */
  at: number
  node: SrcNode
}

/** Which end of the selection a boundary is — decides which way an unprovable mapping widens. */
export type Side = 'start' | 'end'

/* Both edge tests take offsets that may fall OUTSIDE the text — a boundary belonging to a sibling is
 * expressed in this node's coordinates and lands negative or past the end. Clamping is essential, not
 * defensive: `'bcd'.slice(0, -2)` is `'b'`, so an unclamped atStart reads "the selection starts before
 * this run" as "it starts two characters in" and refuses to pair up the run's delimiters. */

/** Is everything before `off` whitespace? (Leading-edge test, tolerant of what a drag can't reach.) */
const atStart = (text: string, off: number): boolean =>
  text.slice(0, Math.max(0, off)).trim() === ''
/** Is everything from `off` on whitespace? A fence's rendered text ends in a newline no drag covers. */
const atEnd = (text: string, off: number): boolean => text.slice(Math.max(0, off)).trim() === ''

/**
 * A fenced code block INVERTS the widen rule: everything else earns its delimiters by being fully
 * covered, a fence earns them only when the selection reaches outside it.
 *
 * The reason is that ```` ``` ```` is the one delimiter people routinely want to leave behind. Grabbing a
 * command out of a transcript to run it, you want the command — not a fence you then delete. But once a
 * selection spans the block AND its surroundings, the fence has to come along: it sits between the two
 * ends in the source, so a slice that omitted it would splice code into prose.
 *
 * Inline code is deliberately NOT fenced — a backtick pair behaves like `**`, earning its delimiters by
 * full coverage, because `foo()` pasted without its ticks silently loses that it was code.
 */
const fenceWiden = (kid: SrcChild, side: Side, other: number): boolean =>
  side === 'start' ? other > kid.at + kid.node.text.length : other < kid.at

/**
 * Does this node contribute nothing but a fenced block? Then it has no delimiters of its OWN to widen
 * to — widening would emit the fence the rule above just declined. Recurses so a wrapper of a wrapper
 * of a fence is still recognised (a message whose entire body is one code block).
 */
function onlyFence(node: SrcNode): boolean {
  if (node.fenced) return true
  const [only] = node.children
  return (
    node.children.length === 1 &&
    only.at === 0 &&
    only.node.text.length === node.text.length &&
    onlyFence(only.node)
  )
}

/**
 * Map a selection — both boundaries at once — from rendered-text offsets to a source span.
 *
 * WIDENING IS ALL-OR-NOTHING. An element's own delimiters are added only when BOTH ends of the
 * selection cover that element: select all of a heading and you get `## Title`, select all of a bold
 * run and you get `**bold**`, select all of a fence and you get the fence. Cover only part of it and
 * you get bare content — which is what keeps a partial code selection from coming back with an opening
 * ```` ``` ```` and no closing one.
 *
 * Both ends have to be resolved together for that: a single boundary can't tell whether it's one edge
 * of a full-element selection or one edge of a partial one.
 *
 * A delimiter that falls inside the span but whose PARTNER doesn't is then cut back out by `unpaired`,
 * which is why the result can be several ranges rather than one. So cutting through a bold run yields
 * `ld text here` — the closing `**` was in range, but emitting it alone would open a new run on paste.
 */
export function resolveSpan(source: string, node: SrcNode, from: number, to: number): SrcRange[] {
  const t0 = Math.max(0, Math.min(from, node.text.length))
  const t1 = Math.max(t0, Math.min(to, node.text.length))
  const a = resolvePoint(source, node, t0, 'start', t1)
  const b = resolvePoint(source, node, t1, 'end', t0)
  const cuts = [...unpaired(source, node, t0, 'start'), ...unpaired(source, node, t1, 'end')]
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
 * a bold run orphans both, and both are cut. Fenced blocks are exempt: their delimiters are already
 * governed by `fenceWiden`, which never leaves one unpaired.
 */
function unpaired(source: string, node: SrcNode, off: number, side: Side): SrcRange[] {
  const out: SrcRange[] = []
  let cur = node
  let here = off
  while (cur.children.length > 0) {
    // Only a boundary STRICTLY inside a child orphans anything; on an edge, the widen rules apply.
    const kid = cur.children.find((k) => here > k.at && here < k.at + k.node.text.length)
    if (!kid) break
    // No "does the selection reach past this run" test is needed: if it doesn't, the delimiter lies
    // outside the resolved span and `subtract` finds nothing to remove. Fences ARE exempt, since
    // fenceWiden governs them and never leaves one unpaired.
    if (!kid.node.fenced) {
      const cut = orphanDelimiter(source, kid.node, side)
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
function orphanDelimiter(source: string, node: SrcNode, side: Side): SrcRange | null {
  if (side === 'start') {
    const contentEnd = mapExact(source, node, node.text.length, 'end', 0)
    return contentEnd === null ? null : { s: contentEnd, e: node.e }
  }
  const contentBegin = mapExact(source, node, 0, 'start', node.text.length)
  return contentBegin === null ? null : { s: node.s, e: contentBegin }
}

/** Remove `cuts` from `range`, leaving the surviving pieces in source order. */
function subtract(range: SrcRange, cuts: SrcRange[]): SrcRange[] {
  let pieces: SrcRange[] = [range]
  for (const cut of cuts) {
    if (cut.e <= cut.s) continue
    pieces = pieces.flatMap((p) => {
      if (cut.e <= p.s || cut.s >= p.e) return [p]
      const kept: SrcRange[] = []
      if (cut.s > p.s) kept.push({ s: p.s, e: cut.s })
      if (cut.e < p.e) kept.push({ s: cut.e, e: p.e })
      return kept
    })
  }
  return pieces.filter((p) => p.e > p.s)
}

function resolvePoint(source: string, node: SrcNode, off: number, side: Side, other: number): number {
  // The whole node is covered — take its own span, delimiters and all. Skipped for a node that is
  // nothing but a fence, whose delimiters are governed by fenceWiden instead.
  if (!onlyFence(node)) {
    if (side === 'start' && atStart(node.text, off) && atEnd(node.text, other)) return node.s
    if (side === 'end' && atEnd(node.text, off) && atStart(node.text, other)) return node.e
  }
  const exact = mapExact(source, node, off, side, other)
  return exact ?? (side === 'start' ? node.s : node.e)
}

function mapExact(source: string, node: SrcNode, off: number, side: Side, other: number): number | null {
  return node.children.length > 0
    ? mapContainer(source, node, off, side, other)
    : mapLeaf(source, node, off)
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
  other: number
): number | null {
  const kids = node.children
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i]
    const kidEnd = kid.at + kid.node.text.length
    if (off < kid.at) return mapGap(source, node, i, off)
    if (off > kidEnd) continue
    const here = off - kid.at
    const far = other - kid.at
    if (off === kid.at && side === 'end') return kid.node.s
    if (off === kidEnd && side === 'start') return kid.node.e
    // Widening over the child's own delimiters. Everything qualifies by the other end covering the
    // child; a fence qualifies by the other end reaching PAST it (see fenceWiden). Either way the
    // boundary itself must sit on the child's edge — a boundary strictly inside a run never widens,
    // and that run's other delimiter is cut back out afterwards by `unpaired`.
    const qualifies = kid.node.fenced
      ? fenceWiden(kid, side, other)
      : side === 'start'
        ? atEnd(kid.node.text, far)
        : atStart(kid.node.text, far)
    if (side === 'start' && atStart(kid.node.text, here) && qualifies) return kid.node.s
    if (side === 'end' && atEnd(kid.node.text, here) && qualifies) return kid.node.e
    // Inside the child (or on its trailing edge without qualifying to widen). Ending exactly at the
    // run's end after starting INSIDE it maps to the content end, not past the closing delimiter —
    // `old text` out of `**bold text**`, never `old text**`. An unpaired delimiter here would be the
    // same defect the widen rule above exists to prevent.
    // A child that can't prove its mapping falls back to ITS own span, not the whole block's: an
    // ambiguous link should widen to the link, not swallow every paragraph around it.
    const inner = mapExact(source, kid.node, here, side, far)
    return inner ?? (side === 'start' ? kid.node.s : kid.node.e)
  }
  return mapGap(source, node, kids.length, off)
}

/**
 * Map an offset inside gap `i` — the plain-text run before child `i` (or after the last child, when
 * `i === children.length`). The gap's source position is anchored to the neighbouring child's span, then
 * VERIFIED by comparing the two strings; an escape (`\*`), an entity, or any other place where rendered
 * text and source diverge fails that check and returns null so the caller widens instead.
 */
function mapGap(source: string, node: SrcNode, i: number, off: number): number | null {
  const kids = node.children
  if (kids.length === 0) return null
  const prev = i > 0 ? kids[i - 1] : null
  const next = i < kids.length ? kids[i] : null
  const t0 = prev ? prev.at + prev.node.text.length : 0
  const t1 = next ? next.at : node.text.length
  if (off < t0 || off > t1) return null
  // Anchor to the preceding child's end where there is one, else back off the following child's start.
  const srcAt = prev ? prev.node.e : (next as SrcChild).node.s - (t1 - t0)
  if (srcAt < 0) return null
  if (source.slice(srcAt, srcAt + (t1 - t0)) !== node.text.slice(t0, t1)) return null
  return srcAt + (off - t0)
}

/**
 * Map an offset inside a leaf — an element with no annotated descendants, so its rendered text is one
 * run sitting somewhere inside its source span. `contentStart` finds where, or refuses.
 */
function mapLeaf(source: string, node: SrcNode, off: number): number | null {
  const src = source.slice(node.s, node.e)
  if (src === node.text) return node.s + off
  const cs = contentStart(src, node.text)
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
      body: sec.parts.map((p) => p.trim()).filter(Boolean).join('\n\n')
    }))
    .filter((sec) => sec.body)
  if (kept.length === 0) return ''
  if (kept.length === 1 && !alwaysLabel) return kept[0].body
  const head = (label: string): string => (plain ? `${label}:` : `**${label}:**`)
  return kept.map((sec) => `${head(sec.label)}\n\n${sec.body}`).join('\n\n---\n\n')
}
