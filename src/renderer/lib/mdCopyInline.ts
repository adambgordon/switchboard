/** Inline output stays typed until escaping and delimiter boundaries have been resolved. */
export const INLINE_STYLE = { em: 1, strong: 2, strike: 4 } as const
export type InlineToken =
  | { kind: 'text' | 'atom'; value: string }
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
    if (!(runs[index].styles & ~inherited)) { append(out, runs[index++].tokens); continue }
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
  tokens.some(token => token.kind === 'marker' || token.kind === 'atom' || (token.kind === 'break' && token.marked))

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

export function emitInline(tokens: InlineToken[], protectLiterals: boolean): string {
  const chunks: Chunk[] = []
  for (const token of tokens) {
    if (token.kind === 'break') chunks.push({ kind: 'atom', value: token.marked ? '\\\n' : '\n' })
    else if (token.value) chunks.push({ ...token, value: token.kind === 'text' && protectLiterals
      ? token.value.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, '\\$&') : token.value })
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
  const encode = (index: number, end: boolean): void => {
    encodeEdge(chunks[index], end)
    for (const affected of touching.get(index) ?? []) pending.push(affected)
  }
  // An edge becomes punctuation after one encoding. Rechecking its neighbours is therefore bounded.
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
