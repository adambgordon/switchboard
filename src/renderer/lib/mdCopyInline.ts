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
const WORD = /[\p{L}\p{N}]/u
const ENTITY = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/
const HTML_OR_AUTOLINK = /[A-Za-z\d/!?]/
interface Pairing { dollar: boolean; tilde: boolean }

const occurrences = (tokens: InlineToken[], char: string, kinds: InlineToken['kind'][]): number =>
  tokens.reduce((n, token) => n + (kinds.includes(token.kind) && 'value' in token ? token.value.split(char).length - 1 : 0), 0)
/** `$` and `~` form syntax only in pairs, so a lone literal stays bare. */
function pairing(scope: InlineToken[]): Pairing {
  return {
    // A math opener scans through code and link metadata for its closer.
    dollar: occurrences(scope, '$', ['text', 'atom', 'code', 'math']) >= 2,
    // Strike delimiters pair only within text; a marker run absorbs a touching literal.
    tilde: occurrences(scope, '~', ['text', 'marker']) >= 2
  }
}

/** Block syntax is recognized after leading whitespace at a line start. */
function lineStartEscapes(value: string, start: number, marks: Set<number>): void {
  let at = start
  while (value[at] === ' ' || value[at] === '\t') at++
  const end = value.indexOf('\n', at)
  const line = value.slice(at, end < 0 ? value.length : end)
  let match: RegExpMatchArray | null
  // A chunk end may continue with any syntax, so it counts as a possible line end.
  if (/^(?:#{1,6}|[-+*>])(?=[ \t]|$)/.test(line) || line[0] === '>') marks.add(at)
  else if ((match = line.match(/^\d{1,9}(?=[.)](?:[ \t]|$))/))) marks.add(at + match[0].length)
  // Setext underlines, thematic breaks, and table delimiter rows can interrupt a paragraph.
  if (/^[-=:|][-=:| \t]*$/.test(line) && /[-=]/.test(line)) marks.add(at + line.search(/[-=]/))
}

/** Escapes only characters that could form syntax where they sit; edges may later become references. */
function escapeLiteral(value: string, lineStart: boolean, passageEnd: boolean, risk: Pairing): string {
  const marks = new Set<number>()
  if (lineStart) lineStartEscapes(value, 0, marks)
  for (let i = value.indexOf('\n'); i >= 0; i = value.indexOf('\n', i + 1)) lineStartEscapes(value, i + 1, marks)
  // A heading drops a final space-separated run of number signs as its closing sequence.
  const closing = passageEnd ? value.match(/(?:^|[ \t])(#+)[ \t\n]*$/) : null
  if (closing) marks.add(closing.index! + closing[0].indexOf('#'))
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i], next = value[i + 1]
    let escape = marks.has(i)
    switch (char) {
      case '`': case '*': case '[': case ']': escape = true; break
      // Boundary repair may turn the final character into a reference, which a bare backslash would escape.
      case '\\': escape ||= next === undefined || next === '\n' || ASCII_PUNCTUATION.test(next) || i + 1 === value.length - 1; break
      // An underscore between word characters can neither open nor close; edges may be re-encoded.
      case '_': escape ||= !(i >= 2 && i <= value.length - 3 && WORD.test(value[i - 1]) && WORD.test(next)); break
      case '<': {
        const run = value.slice(i).match(/^\S*/)![0]
        escape ||= next === undefined || HTML_OR_AUTOLINK.test(next) || run.includes('>') || run.length === value.length - i
        break
      }
      case '&': escape ||= ENTITY.test(value.slice(i)); break
      case '$': escape ||= risk.dollar; break
      case '~': escape ||= risk.tilde; break
    }
    out += escape ? '\\' + char : char
  }
  return out
}

/** `scope` holds every token a destination parses as one passage, for pairing decisions. */
export function emitInline(tokens: InlineToken[], protectLiterals: boolean, scope: InlineToken[] = tokens): string {
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
  if (protectLiterals) {
    const risk = pairing(scope)
    let last = chunks.length - 1
    while (last >= 0 && !/\S/.test(chunks[last].value)) last--
    chunks.forEach((chunk, index) => {
      if (chunk.kind !== 'text') return
      const lineStart = index === 0 || chunks[index - 1].value.endsWith('\n')
      chunk.value = escapeLiteral(chunk.value, lineStart, index === last, risk)
    })
  }
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
