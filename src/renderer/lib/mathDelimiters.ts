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

const covered = (ranges: readonly Range[], start: number, end: number): boolean =>
  ranges.some(([s, e]) => start >= s && end <= e)

/**
 * Cheap pre-gate: does ANY line consist solely of an opening display delimiter?
 *
 * A display block is the entry condition for everything else, so a text without one can be
 * rejected before any range-building or allocation. This runs on every rendered block in a
 * transcript, so it walks the string in place rather than splitting it — a block that merely
 * mentions a `$` should not pay for a full scan.
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
 * Spans that must never be treated as math: fenced code blocks (their markers included) and
 * inline code spans. Code-span closing follows CommonMark — a run of N backticks is closed by
 * the next run of exactly N.
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
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
    } else if (marker) {
      fence = marker[1]
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
  return ranges
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

  const found: DisplayBlock[] = []
  for (let i = 0; i < lines.length; i++) {
    const kind = opens(i)
    if (!kind) continue
    const token = kind === 'latex' ? '\\[' : '$$'
    const openAt = lineStart[i] + lines[i].indexOf(token)
    if (covered(ranges, openAt, openAt + 2)) continue
    for (let j = i + 1; j < lines.length; j++) {
      if (!closes(j, kind)) continue
      const closeToken = kind === 'latex' ? '\\]' : '$$'
      const closeAt = lineStart[j] + lines[j].indexOf(closeToken)
      // A closer inside code does not close anything; abandon this opener rather than
      // reaching past it, which would swallow the code span into a formula.
      if (covered(ranges, closeAt, closeAt + 2)) break
      found.push({
        kind,
        openAt,
        closeAt,
        bodyStart: lineStart[i] + lines[i].length + 1,
        bodyEnd: lineStart[j]
      })
      i = j
      break
    }
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

  const chars = Array.from(text)
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
    if (covered(ranges, start, end) || inBody(start)) continue
    write(start)
    write(end - 2)
  }

  return { text: chars.join(''), hasMath: true, singleDollar: singleDollarFrom(blocks) }
}
