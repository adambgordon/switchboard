/**
 * Math delimiter normalization — the gate in front of the Formatted view's math rendering.
 *
 * Agents write math four ways, and BOTH agents use all four: `\(…\)` / `$…$` inline, and
 * `\[…\]` / `$$…$$` display. `remark-math` understands only the dollar forms, so the LaTeX
 * forms are rewritten onto them here.
 *
 * TWO PROPERTIES MAKE THIS SAFE, AND BOTH ARE LOAD-BEARING:
 *
 * 1. THE REWRITE IS LENGTH-PRESERVING. Every substitution is two characters for two
 *    (`\(`→`$$`, `\)`→`$$`, `\[`→`$$`, `\]`→`$$`), so a source offset computed against the
 *    rewritten text indexes the ORIGINAL text identically. That is what lets the copy
 *    pipeline keep slicing the untouched source — a formula copies back as the `\(P_i\)` the
 *    agent actually wrote, and every offset after a formula stays correct. A rewrite of
 *    unequal length would silently shift them and corrupt markdown copy for the rest of
 *    the block. Any change here MUST preserve length.
 *
 * 2. MATH IS OPT-IN PER BLOCK, VIA A DISPLAY BLOCK. These delimiters are not reliable math
 *    markers in coding-agent prose, because they all mean something else far more often:
 *      • `\[DEBUG\]` is how CommonMark writes a LITERAL `[DEBUG]` — it renders correctly
 *        today, and treating it as math turns a log tag into a centered equation.
 *      • `sed` capture groups (`s/x\([0-9]*\)/\1/p`) and `jq` interpolation (`"\(.name)"`).
 *      • `$PATH`, `${dir}`, `$(cmd)` — shell sigils.
 *    So nothing is math unless the block contains a DISPLAY block whose delimiters sit alone
 *    on their own lines. That shape does not occur by accident, and it is what admits the
 *    inline forms. A block without one is returned untouched.
 *
 * Fenced and inline code are excluded throughout — from detection as well as rewriting — so
 * a fenced ```latex sample stays visible source rather than becoming rendered math.
 */

export interface MathNormalization {
  /** The text to hand the markdown parser. Same LENGTH as the input, always. */
  text: string
  /** Did a display block admit math? When false, `text` is the input unchanged. */
  hasMath: boolean
  /** May `$…$` be read as inline math? See `singleDollarFrom` below. */
  singleDollar: boolean
}

type Range = readonly [number, number]

/**
 * Does `[start, end)` touch any protected range AT ALL?
 *
 * Overlap, not containment. A delimiter pair can begin inside a code span and end outside it
 * (`` `code \(x` then \) ``); requiring full containment would call that "not in code" and rewrite
 * straight through the span. Anything that so much as touches code is out.
 */
const touchesCode = (ranges: readonly Range[], start: number, end: number): boolean =>
  ranges.some(([s, e]) => start < e && end > s)

/**
 * Cheap pre-filter: does ANY line consist solely of an opening display delimiter?
 *
 * A display block is the entry condition for everything else, so a text without one can be rejected
 * before any range-building or allocation. This runs on every rendered block in a transcript, so it
 * walks the string in place rather than splitting it — a block that merely mentions a `$` should not
 * pay for a full scan.
 *
 * A FILTER, NOT A GATE: correctness rests on `displayBlocks`'s `opens`/`closes`, which re-test each
 * line strictly. Loosening the match here can only cost a wasted scan, never admit a non-delimiter —
 * which is why no test pins this shape, and why loosening it produces no test failure.
 */
function mightHaveDisplay(text: string): boolean {
  if (!text.includes('\\[') && !text.includes('$$')) return false
  let start = 0
  while (start <= text.length) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    let a = start
    let b = end
    while (a < b && (text[a] === ' ' || text[a] === '\t')) a++
    while (b > a && (text[b - 1] === ' ' || text[b - 1] === '\t' || text[b - 1] === '\r')) b--
    if (b - a === 2 && ((text[a] === '\\' && text[a + 1] === '[') || (text[a] === '$' && text[a + 1] === '$'))) {
      return true
    }
    start = end + 1
  }
  return false
}

/**
 * Spans that must never be treated as math: fenced code blocks (their markers included), indented
 * code blocks, and inline code spans. Code-span closing follows CommonMark — a run of N backticks is
 * closed by the next run of exactly N.
 *
 * This deliberately OVER-excludes. Indented code is matched as "any line indented four or more
 * spaces" rather than by CommonMark's real rules (which depend on preceding blank lines, paragraph
 * continuation, and list nesting). Over-excluding costs an occasional unrendered formula;
 * under-excluding rewrites someone's code sample — and the second is the failure that matters, so
 * the crude rule is the correct one here.
 */
export function codeRanges(text: string): Range[] {
  const ranges: Range[] = []
  const lines = text.split('\n')
  let offset = 0
  let fence: string | null = null
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      ranges.push([offset, offset + line.length + 1])
      // Only whitespace may follow a CLOSING fence marker — ```` ```trailing ```` is not a closer,
      // so a fence closed on it would leave the rest of the sample exposed as prose.
      const closes = marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
      if (closes && line.slice(marker.index + marker[0].length).trim() === '') fence = null
    } else if (marker) {
      fence = marker[1]
      ranges.push([offset, offset + line.length + 1])
    } else if (/^(?: {4}|\t)/.test(line) && line.trim() !== '') {
      ranges.push([offset, offset + line.length + 1])
    }
    offset += line.length + 1
  }
  const inFence = (i: number): boolean => ranges.some(([s, e]) => i >= s && i < e)

  let i = 0
  while (i < text.length) {
    if (text[i] !== '`') {
      i++
      continue
    }
    let run = 0
    while (text[i + run] === '`') run++
    if (inFence(i)) {
      i += run
      continue
    }
    // Look for a closing run of exactly the same length.
    let j = i + run
    let close = -1
    while (j < text.length) {
      if (text[j] !== '`') {
        j++
        continue
      }
      let other = 0
      while (text[j + other] === '`') other++
      if (other === run) {
        close = j
        break
      }
      j += other
    }
    if (close === -1) {
      i += run
      continue
    }
    ranges.push([i, close + run])
    i = close + run
  }

  /* Merge before returning. The scan above emits one range PER LINE of a fenced or indented block,
   * and every delimiter candidate then tests itself against the whole list — so a large code sample
   * would cost (lines × ranges) even though the pairing walk itself is linear. A fence's per-line
   * ranges are contiguous by construction, so merging collapses a block of any size to ONE range and
   * the test becomes proportional to the number of distinct code regions instead of lines. */
  if (ranges.length < 2) return ranges
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Range[] = [sorted[0]]
  for (const [start, end] of sorted.slice(1)) {
    const last = merged[merged.length - 1]
    if (start <= last[1]) merged[merged.length - 1] = [last[0], Math.max(last[1], end)]
    else merged.push([start, end])
  }
  return merged
}

interface DisplayBlock {
  /** Which delimiter family opened it — the evidence `singleDollarFrom` reads. */
  kind: 'latex' | 'dollar'
  openAt: number
  closeAt: number
  bodyStart: number
  bodyEnd: number
}

/** Display blocks whose delimiters each sit alone on their own line, outside code. */
function displayBlocks(text: string, ranges: readonly Range[]): DisplayBlock[] {
  const lines = text.split('\n')
  const lineStart: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStart.push(offset)
    offset += line.length + 1
  }
  const opens = (i: number): DisplayBlock['kind'] | null => {
    if (/^\s*\\\[\s*$/.test(lines[i])) return 'latex'
    if (/^\s*\$\$\s*$/.test(lines[i])) return 'dollar'
    return null
  }
  const closes = (i: number, kind: DisplayBlock['kind']): boolean =>
    kind === 'latex' ? /^\s*\\\]\s*$/.test(lines[i]) : /^\s*\$\$\s*$/.test(lines[i])

  /* ONE pass. An earlier version rescanned every remaining line for each unmatched opener, which is
   * quadratic — a block of a few thousand stray `\[` lines cost most of a second inside a synchronous
   * render. Carrying the pending opener instead makes it linear, and removes the nested loop. */
  const found: DisplayBlock[] = []
  let pending: { kind: DisplayBlock['kind']; line: number; at: number } | null = null

  for (let i = 0; i < lines.length; i++) {
    if (pending !== null) {
      if (!closes(i, pending.kind)) continue
      const closeAt = lineStart[i] + lines[i].indexOf(pending.kind === 'latex' ? '\\]' : '$$')
      // A closer inside code closes nothing: drop the opener rather than reaching past the code,
      // which would swallow the span into a formula.
      if (touchesCode(ranges, closeAt, closeAt + 2)) {
        pending = null
        continue
      }
      found.push({
        kind: pending.kind,
        openAt: pending.at,
        closeAt,
        bodyStart: lineStart[pending.line] + lines[pending.line].length + 1,
        bodyEnd: lineStart[i]
      })
      pending = null
      continue
    }
    const kind = opens(i)
    if (!kind) continue
    const openAt = lineStart[i] + lines[i].indexOf(kind === 'latex' ? '\\[' : '$$')
    if (touchesCode(ranges, openAt, openAt + 2)) continue
    pending = { kind, line: i, at: openAt }
  }
  return found
}

/**
 * May `$…$` be read as inline math in this block?
 *
 * Single `$` is the one genuinely ambiguous delimiter — it collides with shell sigils, which
 * outnumber math in coding-agent prose by orders of magnitude. So it is admitted only when the
 * block wrote its DISPLAY math with `$$`.
 *
 * That is evidence the block supplies about its own convention: a block using `$$…$$` has
 * demonstrated that `$` means math here. A block using `\[…\]` has demonstrated the opposite —
 * its inline math will be `\(…\)` (which is unambiguous and always rendered), so a bare `$` in
 * it is far likelier to be a shell sigil, and is left alone.
 *
 * Deliberately STRUCTURAL rather than a look-at-the-contents guess, so it cannot be fooled by
 * what a particular formula or shell command happens to contain. When the two readings conflict,
 * failing to render real math is the better outcome — a formula shown as source is still
 * readable, whereas a mangled shell command is misinformation.
 */
const singleDollarFrom = (blocks: readonly DisplayBlock[]): boolean =>
  blocks.some((block) => block.kind === 'dollar')

export function normalizeMath(text: string): MathNormalization {
  // The overwhelming majority of blocks leave here, having allocated nothing.
  if (!mightHaveDisplay(text)) return { text, hasMath: false, singleDollar: false }

  const ranges = codeRanges(text)
  const blocks = displayBlocks(text, ranges)
  // No display block ⇒ this block is not doing math. Return it untouched.
  if (blocks.length === 0) return { text, hasMath: false, singleDollar: false }

  /* `split('')`, NOT `Array.from` — the difference is load-bearing. Every offset here comes from
   * `indexOf` / `RegExp.index` / `line.length`, which count UTF-16 code UNITS, while `Array.from`
   * yields one slot per code POINT. One astral character (an emoji) before a formula desynchronises
   * the two, and the write lands on the wrong character: it can eat a newline, leave a stray
   * backslash, or change the string's length outright — all silently, since the delimiters still
   * look plausible afterwards. */
  const chars = text.split('')
  const write = (at: number): void => {
    chars[at] = '$'
    chars[at + 1] = '$'
  }

  for (const block of blocks) {
    if (block.kind !== 'latex') continue
    write(block.openAt)
    write(block.closeAt)
  }

  // A display body is already math; rewriting inside it would corrupt the formula.
  const bodies: Range[] = blocks.map((b) => [b.bodyStart, b.bodyEnd])
  const inBody = (i: number): boolean => bodies.some(([s, e]) => i >= s && i < e)

  // Inline `\(…\)` — paired, and confined to one line, since real inline math does not wrap.
  // An unpaired `\(` (a regex like `def map\(`) is left alone by construction.
  const inline = /\\\((?:(?!\\\)|\n)[\s\S])*\\\)/g
  let match: RegExpExecArray | null
  while ((match = inline.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (touchesCode(ranges, start, end) || inBody(start)) continue
    write(start)
    write(end - 2)
  }

  return { text: chars.join(''), hasMath: true, singleDollar: singleDollarFrom(blocks) }
}
