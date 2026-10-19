/** Inline output stays typed until escaping and delimiter boundaries have been resolved. */
export const INLINE_STYLE = { em: 1, strong: 2, strike: 4 } as const
export type InlineToken =
  | { kind: 'text' | 'atom' | 'code' | 'math'; value: string }
  | { kind: 'break'; marked: boolean }
  | { kind: 'marker'; value: string; open: boolean }
export interface InlineRun { styles: number; tokens: InlineToken[] }

function append(target: InlineToken[], source: InlineToken[], from = 0, to = source.length): void {
  for (let i = from; i < to; i++) target.push(source[i])
}

function wrapStyle(body: InlineToken[], marker: string): InlineToken[] {
  const before: InlineToken[] = [], after: InlineToken[] = []
  let start = 0, end = body.length
  while (start < end) {
    const token = body[start]
    if (token.kind === 'break') { before.push(token); start++; continue }
    if (token.kind !== 'text') break
    const length = token.value.length - token.value.trimStart().length
    if (!length) break
    before.push({ kind: 'text', value: token.value.slice(0, length) })
    if (length === token.value.length) start++
    else { body[start] = { kind: 'text', value: token.value.slice(length) }; break }
  }
  while (end > start) {
    const token = body[end - 1]
    if (token.kind === 'break') { after.push(token); end--; continue }
    if (token.kind !== 'text') break
    const length = token.value.trimEnd().length
    if (length === token.value.length) break
    after.push({ kind: 'text', value: token.value.slice(length) })
    if (!length) end--
    else { body[end - 1] = { kind: 'text', value: token.value.slice(0, length) }; break }
  }
  const out = before
  if (start < end) {
    out.push({ kind: 'marker', value: marker, open: true })
    append(out, body, start, end)
    out.push({ kind: 'marker', value: marker, open: false })
  }
  for (let i = after.length - 1; i >= 0; i--) out.push(after[i])
  return out
}

/** Common attention stays open across runs; strike remains innermost. */
export function planInline(runs: InlineRun[], inherited = 0, from = 0, to = runs.length): InlineToken[] {
  const out: InlineToken[] = []
  for (let index = from; index < to;) {
    if (!(runs[index].styles & ~inherited)) {
      for (const token of runs[index++].tokens) {
        if ((token.kind === 'code' || token.kind === 'math') && out[out.length - 1]?.kind === token.kind) {
          // Touching delimiters merge atoms. A redundant retained style separates them without text.
          const marker = inherited & INLINE_STYLE.em ? '_' : inherited & INLINE_STYLE.strong ? '__' : ''
          if (!marker) throw new Error('Unrepresentable adjacent Markdown atoms')
          append(out, wrapStyle([token], marker))
        } else out.push(token)
      }
      continue
    }
    let style = 0, end = index
    for (const candidate of [INLINE_STYLE.em, INLINE_STYLE.strong]) {
      let limit = index
      while (limit < to && (runs[limit].styles & ~inherited & candidate)) limit++
      if (limit > end) { style = candidate; end = limit }
    }
    if (!style) {
      style = INLINE_STYLE.strike
      end = index + 1
      while (end < to && (runs[end].styles & ~inherited) === INLINE_STYLE.strike) end++
    }
    const marker = style === INLINE_STYLE.em ? '*' : style === INLINE_STYLE.strong ? '**' : '~~'
    append(out, wrapStyle(planInline(runs, inherited | style, index, end), marker))
    index = end
  }
  return out
}

export const hasInlineMarkup = (tokens: InlineToken[]): boolean =>
  tokens.some(token => token.kind !== 'text' && (token.kind !== 'break' || token.marked))

interface Chunk { kind: 'text' | 'atom' | 'marker'; value: string; open?: boolean }
interface Boundary { before: number; after: number; opens: boolean; closes: boolean }

function boundaryClass(value: string, end: boolean): number {
  // micromark classifies UTF-16 boundary units, including surrogate units, as tokenizer codes.
  const char = end ? value.charAt(value.length - 1) : value.charAt(0)
  return !char || /\s/.test(char) ? 1 : /[\p{P}\p{S}]/u.test(char) ? 2 : 0
}
function encodeEdge(chunk: Chunk, end: boolean): void {
  // Only literal characters may change representation; syntax and atomic payloads are protected.
  if (chunk.kind !== 'text') throw new Error('Non-literal Markdown boundary')
  let offset = end ? chunk.value.length - 1 : 0
  if (end && /[\uDC00-\uDFFF]/.test(chunk.value[offset]) && /[\uD800-\uDBFF]/.test(chunk.value[offset - 1] ?? '')) offset--
  const point = chunk.value.codePointAt(offset)!
  const width = point > 0xffff ? 2 : 1
  chunk.value = chunk.value.slice(0, offset) + `&#${point};` + chunk.value.slice(offset + width)
}

const ASCII_PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/
// Sticky patterns test at a position without copying the rest of the chunk.
const ENTITY = /&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/y
const NON_SPACE_RUN = /\S*/y
const at = (pattern: RegExp, value: string, index: number): RegExpExecArray | null => {
  pattern.lastIndex = index
  return pattern.exec(value)
}
/** An ampersand that a parser would read as the start of a character reference. */
export const ENTITY_AMPERSAND = /&(?=#\d{1,7};|#[xX][\da-fA-F]{1,6};|[A-Za-z][A-Za-z\d]{1,31};)/g
const HTML_OR_AUTOLINK = /[A-Za-z\d/!?]/
const BARE_URL = /https?:\/\/|www\./gi
const URL_RUN = /[^\s<]*/y
const URL_TRAILING = /[?!.,:*_~]/

/** Options describing where an inline passage sits once pasted. */
export interface InlineContext {
  /** False after heading syntax or in a table cell, whose content is inline-only. */
  blockStart?: boolean
  /** A heading body, whose final space-separated number signs would be read as a closing sequence. */
  heading?: boolean
}

// micromark's character groups: whitespace (and passage edges), punctuation or symbol, anything else.
const group = (char: string | undefined): number =>
  char === undefined || /\s/.test(char) ? 1 : /[\p{P}\p{S}]/u.test(char) ? 2 : 0

/** Block syntax is recognized after leading whitespace at a line start. Pushes the positions to escape. */
function lineStartEscapes(text: string, start: number, opening: boolean, out: number[]): void {
  let at = start
  while (text[at] === ' ' || text[at] === '\t') at++
  const end = text.indexOf('\n', at)
  const line = text.slice(at, end < 0 ? text.length : end)
  let match: RegExpMatchArray | null
  if (/^(?:#{1,6}|[-+*])(?=[ \t]|$)|^>|^\$\$|^~~~|^<[A-Za-z/!?]/.test(line)) out.push(at)
  // Only an ordered list starting at one can interrupt a paragraph.
  else if ((match = line.match(opening ? /^\d{1,9}(?=[.)](?:[ \t]|$))/ : /^1(?=[.)](?:[ \t]|$))/))) out.push(at + match[0].length)
  // A task box or a reference definition.
  else if (/^\[(?:[ xX]\](?=[ \t]|$)|[^\]]*\]:)/.test(line)) out.push(at)
  // Setext underlines, thematic breaks, and table delimiter rows can interrupt a paragraph.
  if (/^[-=:|][-=:| \t]*$/.test(line) && /[-=]/.test(line)) out.push(at + line.search(/[-=]/))
  if (/^([*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) out.push(at)
}

interface Run { char: string; from: number; to: number; open: boolean; close: boolean; literal: number[] }

/**
 * Marks the literal characters of a passage that could form syntax once pasted. Delimiters are escaped only when
 * they touch generated syntax or could pair with another delimiter under the parser's open/close rules.
 */
function escapePassage(chunks: Chunk[], context: InlineContext): void {
  const starts: number[] = []
  let length = 0
  for (const chunk of chunks) {
    starts.push(length)
    length += chunk.value.length
  }
  const text = chunks.map(chunk => chunk.value).join('')
  // The chunk owning each character of the passage.
  const source = new Int32Array(text.length)
  chunks.forEach((chunk, index) => source.fill(index, starts[index], starts[index] + chunk.value.length))
  const kind = (p: number): Chunk['kind'] | 'edge' => p < 0 || p >= text.length ? 'edge' : chunks[source[p]].kind
  // One flag per literal character; set flags are escaped.
  const marks = chunks.map(chunk => new Uint8Array(chunk.kind === 'text' ? chunk.value.length : 0))
  const mark = (p: number): void => { marks[source[p]][p - starts[source[p]]] = 1 }
  // Boundary repair may later turn a literal edge beside a marker into a reference, which reads as punctuation.
  const repairable = (p: number): boolean => {
    if (kind(p) !== 'text') return false
    const index = source[p], offset = p - starts[index]
    return (offset === 0 && chunks[index - 1]?.kind === 'marker') ||
      (offset === chunks[index].value.length - 1 && chunks[index + 1]?.kind === 'marker')
  }
  // The possible character groups at a position, as a bit set.
  const groups = (p: number): number => {
    const value = group(text[p])
    return value === 0 && repairable(p) ? 0b101 : 1 << value
  }
  const counts = (q: number, char: string): boolean => text[q] === char && (char === '$' || kind(q) !== 'atom')
  // With strikethrough enabled, a tilde is an attention marker too.
  const attention = (char: string | undefined): boolean => char === '*' || char === '_' || char === '~'

  // Delimiter runs. Atom payloads bind tighter than emphasis, so only math pairing sees into them.
  const runs: Run[] = []
  const delimiter = /[*_~$]/g
  for (let match = delimiter.exec(text); match; match = delimiter.exec(text)) {
    const p = match.index, char = match[0]
    if (!counts(p, char)) continue
    let q = p
    while (counts(q, char)) q++
    delimiter.lastIndex = q
    const literal: number[] = []
    for (let i = p; i < q; i++) if (kind(i) === 'text') literal.push(i)
    // A literal that touches generated syntax is escaped. The generated characters then form their own runs beside an
    // escaped marker character, which any neighbor may let open or close.
    if (literal.length && literal.length < q - p) {
      literal.forEach(mark)
      for (let i = p; i < q;) {
        if (kind(i) === 'text') { i++; continue }
        let j = i
        while (j < q && kind(j) !== 'text') j++
        runs.push({ char, from: i, to: j, open: true, close: true, literal: [] })
        i = j
      }
      continue
    }
    let open = false, close = false
    const lefts = groups(p - 1), rights = groups(q)
    for (let left = 0; left < 3; left++) for (let right = 0; right < 3; right++) {
      if (!(lefts & (1 << left)) || !(rights & (1 << right))) continue
      if (char === '*' || char === '_') {
        const opens = right === 0 || (right === 2 && left !== 0) || attention(text[q])
        const closes = left === 0 || (left === 2 && right !== 0) || attention(text[p - 1])
        open ||= char === '*' ? opens : opens && (left !== 0 || !closes)
        close ||= char === '*' ? closes : closes && (right !== 0 || !opens)
      } else if (char === '~') {
        // A run longer than two is never strikethrough.
        if (q - p > 2) continue
        open ||= right === 0 || (right === 2 && left !== 0)
        close ||= left === 0 || (left === 2 && right !== 0)
      } else if (q - p === 1) {
        // Single-dollar math needs a non-space inside each delimiter and no digit after the closer.
        open ||= right !== 1
        close ||= left !== 1 && (!/\d/.test(text[q] ?? '') || repairable(q))
      } else {
        open = close = true
      }
    }
    runs.push({ char, from: p, to: q, open, close, literal })
  }
  // Emphasis pairs any sizes of one marker; strikethrough and math pair equal sizes only.
  const key = (run: Run): string => run.char === '*' || run.char === '_' ? run.char : run.char + (run.to - run.from)
  const openBefore: boolean[] = [], closeAfter: boolean[] = []
  const opened = new Set<string>(), closed = new Set<string>()
  runs.forEach((run, index) => { openBefore[index] = opened.has(key(run)); if (run.open) opened.add(key(run)) })
  for (let index = runs.length - 1; index >= 0; index--) {
    closeAfter[index] = closed.has(key(runs[index]))
    if (runs[index].close) closed.add(key(runs[index]))
  }
  runs.forEach((run, index) => {
    if (run.literal.length === run.to - run.from && ((run.open && closeAfter[index]) || (run.close && openBefore[index]))) {
      run.literal.forEach(mark)
    }
  })

  // Block syntax is checked on whole lines, which can span chunks, such as the cells of a grid row.
  const lineEscapes: number[] = []
  if (context.blockStart !== false) lineStartEscapes(text, 0, true, lineEscapes)
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    // A line after a blank one opens a new paragraph, where any block may start.
    let j = i - 1
    while (text[j] === ' ' || text[j] === '\t') j--
    lineStartEscapes(text, i + 1, j < 0 || text[j] === '\n', lineEscapes)
  }
  for (const p of lineEscapes) if (kind(p) === 'text') mark(p)

  let last = chunks.length - 1
  while (last >= 0 && !/\S/.test(chunks[last].value)) last--
  let depth = 0
  const lastTagEnd = text.lastIndexOf('>')
  // Text chunks outside link labels, where a bare URL becomes a link.
  const unlabeled: number[] = []
  chunks.forEach((chunk, index) => {
    if (chunk.kind === 'atom') {
      if (chunk.value === '[' || chunk.value === '![') depth++
      else if (chunk.value.startsWith('](')) depth = Math.max(0, depth - 1)
    }
    if (chunk.kind !== 'text') return
    if (depth === 0) unlabeled.push(index)
    const value = chunk.value, own = marks[index], offset = starts[index]
    const closing = context.heading && index === last ? value.match(/(?:^|[ \t])(#+)[ \t\n]*$/) : null
    if (closing) own[closing.index! + closing[0].indexOf('#')] = 1
    const special = /[`[\]\\<&!]/g
    // The non-space run and the next `>` are shared by every `<` before them, so each is found once.
    let runEnd = -1, nextTagEnd = -1
    for (let found = special.exec(value); found; found = special.exec(value)) {
      const i = found.index, char = found[0], next = value[i + 1]
      switch (char) {
        case '`': own[i] = 1; break
        // Inside link text any bracket may rebalance the label; elsewhere only a resource or reference can follow.
        case '[': if (depth > 0) own[i] = 1; break
        case ']': if (depth > 0 || text[offset + i + 1] === '(' || text[offset + i + 1] === '[') own[i] = 1; break
        // Boundary repair may turn the final character into a reference, which a bare backslash would escape.
        case '\\':
          if (next === undefined || next === '\n' || ASCII_PUNCTUATION.test(next) || i + 1 === value.length - 1) own[i] = 1
          break
        // A tag or autolink needs a closing angle bracket.
        case '<': {
          if (lastTagEnd <= offset + i) break
          if (runEnd < i) runEnd = i + at(NON_SPACE_RUN, value, i)![0].length
          if (nextTagEnd < i) {
            const tag = value.indexOf('>', i)
            nextTagEnd = tag < 0 ? Infinity : tag
          }
          if (HTML_OR_AUTOLINK.test(next ?? '') || nextTagEnd < runEnd || runEnd === value.length) own[i] = 1
          break
        }
        case '&': if (at(ENTITY, value, i)) own[i] = 1; break
        // A literal `!` right before a link's opening bracket would make the link an image.
        case '!': if (i === value.length - 1 && chunks[index + 1]?.kind === 'atom' && chunks[index + 1].value === '[') own[i] = 1; break
      }
    }
  })
  // Escaping part of a delimiter run would leave the rest as a shorter, still active run.
  for (const run of runs) if (run.literal.some(p => marks[source[p]][p - starts[source[p]]])) run.literal.forEach(mark)
  // A bare URL runs to the next space or `<`, so syntax or an escape inside it would become part of the link; only
  // trailing sentence and marker punctuation stays outside. Escaping its scheme separator keeps it plain text.
  let urlEnd = -1, solidEnd = -1
  let generated: Int32Array | undefined, escaped: Int32Array | undefined
  for (const index of unlabeled) for (const url of chunks[index].value.matchAll(BARE_URL)) {
    const p = starts[index] + url.index!
    if (urlEnd <= p) {
      urlEnd = p + at(URL_RUN, text, p)![0].length
      solidEnd = urlEnd
      while (solidEnd > p && URL_TRAILING.test(text[solidEnd - 1])) solidEnd--
    }
    if (!generated || !escaped) {
      generated = new Int32Array(text.length + 1)
      escaped = new Int32Array(text.length + 1)
      for (let q = 0; q < text.length; q++) {
        const literal = kind(q) === 'text'
        generated[q + 1] = generated[q] + (literal ? 0 : 1)
        escaped[q + 1] = escaped[q] + (literal ? marks[source[q]][q - starts[source[q]]] : 0)
      }
    }
    // An escaped `<` that ends the URL would put its backslash inside it.
    if (generated[solidEnd] - generated[p] || escaped[Math.min(urlEnd + 1, text.length)] - escaped[p + 1]) {
      mark(p + url[0].search(/[:.]/))
    }
  }
  chunks.forEach((chunk, index) => {
    if (chunk.kind !== 'text' || marks[index].indexOf(1) < 0) return
    const out: string[] = []
    let from = 0
    for (let offset = marks[index].indexOf(1); offset >= 0; offset = marks[index].indexOf(1, offset + 1)) {
      out.push(chunk.value.slice(from, offset), '\\')
      from = offset
    }
    out.push(chunk.value.slice(from))
    chunk.value = out.join('')
  })
}

/** `context` describes where the passage lands once pasted, for decisions that depend on its surroundings. */
export function emitInline(tokens: InlineToken[], protectLiterals: boolean, context: InlineContext = {}): string {
  const chunks = toChunks(tokens)
  if (protectLiterals) escapePassage(chunks, context)
  return repairBoundaries(chunks)
}

/**
 * A grid pastes as running lines, its cells separated by tabs and its rows by newlines, so delimiters in one cell can
 * pair with another's. Its literals are therefore escaped as one passage; boundaries are still repaired per cell.
 */
export function emitGrid(rows: InlineToken[][][], protectLiterals: boolean): string[][] {
  const cells = rows.map(row => row.map(toChunks))
  if (protectLiterals) {
    const passage: Chunk[] = []
    // A field holding a separator or quote is pasted in quotes, which are punctuation to the parser.
    const multiple = cells.reduce((n, row) => n + row.length, 0) > 1
    cells.forEach((row, r) => row.forEach((chunks, c) => {
      if (r || c) passage.push({ kind: 'atom', value: c ? '\t' : '\n' })
      const quoted = multiple && chunks.some(chunk => /[\t\r\n"]/.test(chunk.value))
      if (quoted) passage.push({ kind: 'atom', value: '"' })
      passage.push(...chunks)
      if (quoted) passage.push({ kind: 'atom', value: '"' })
    }))
    escapePassage(passage, {})
  }
  return cells.map(row => row.map(repairBoundaries))
}

function toChunks(tokens: InlineToken[]): Chunk[] {
  const chunks: Chunk[] = []
  // A Markdown hard break needs following inline content. Terminal newlines stay literal.
  let tail = tokens.length
  while (tail > 0) {
    const token = tokens[tail - 1]
    if (token.kind !== 'break' && !(token.kind === 'text' && !/\S/.test(token.value))) break
    tail--
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.kind === 'break') chunks.push({ kind: 'atom', value: token.marked && index < tail ? '\\\n' : '\n' })
    // Adjacent literals are one span to the parser, so escaping decisions must see across them.
    else if (token.kind === 'text' && chunks[chunks.length - 1]?.kind === 'text') chunks[chunks.length - 1].value += token.value
    else if (token.value) chunks.push({ ...token, kind: token.kind === 'code' || token.kind === 'math' ? 'atom' : token.kind })
  }
  return chunks
}

function repairBoundaries(chunks: Chunk[]): string {
  const boundaries: Boundary[] = []
  const touching = new Map<number, number[]>()
  for (let index = 0; index < chunks.length;) {
    if (chunks[index].kind !== 'marker') { index++; continue }
    const family = chunks[index].value[0]
    let end = index, opens = false, closes = false
    while (end < chunks.length && chunks[end].kind === 'marker' && chunks[end].value[0] === family) {
      opens ||= chunks[end].open === true
      closes ||= chunks[end].open === false
      end++
    }
    const boundary = { before: index - 1, after: end, opens, closes }
    for (const side of [boundary.before, boundary.after]) {
      const affected = touching.get(side) ?? []
      affected.push(boundaries.length)
      touching.set(side, affected)
    }
    boundaries.push(boundary)
    index = end
  }
  const pending = boundaries.map((_, index) => index)
  const repaired = new Map<number, number>()
  const encode = (index: number, end: boolean): void => {
    const side = end ? 2 : 1
    const previous = repaired.get(index) ?? 0
    if (previous & side) throw new Error('Repeated Markdown boundary repair')
    encodeEdge(chunks[index], end)
    repaired.set(index, previous | side)
    for (const affected of touching.get(index) ?? []) pending.push(affected)
  }
  // Each chunk edge can be repaired once; only a successful repair queues neighboring boundaries.
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const boundary = boundaries[pending[cursor]]
    const before = boundaryClass(chunks[boundary.before]?.value ?? '', true)
    const after = boundaryClass(chunks[boundary.after]?.value ?? '', false)
    const leftFlanking = after !== 1 && (after !== 2 || before !== 0)
    const rightFlanking = before !== 1 && (before !== 2 || after !== 0)
    if (boundary.opens && !leftFlanking) encode(boundary.before, true)
    if (boundary.closes && !rightFlanking) encode(boundary.after, false)
  }
  return chunks.map(chunk => chunk.value).join('')
}
