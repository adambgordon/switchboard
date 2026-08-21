import { describe, expect, it } from 'vitest'
import {
  assembleCopy,
  fence,
  resolveSpan,
  type SpanContext,
  type SrcChild,
  type SrcNode
} from '../src/renderer/lib/mdCopy'

/**
 * The offsets below are the REAL ones react-markdown produces — each fixture was checked against a
 * rendered tree (`## A heading` → h2 [0,12), `**bold text**` → strong [19,32), a fence → pre [75,96)),
 * so a passing test means the mapper agrees with the renderer rather than with a convenient invention.
 */

const node = (s: number, e: number, text: string, children: SrcChild[] = []): SrcNode => ({
  s,
  e,
  text,
  children
})
const kid = (at: number, n: SrcNode): SrcChild => ({ at, node: n })
const structural = (
  kind: NonNullable<SrcNode['kind']>,
  s: number,
  e: number,
  text: string,
  children: SrcChild[] = []
): SrcNode => ({ s, e, text, children, kind })
/** An inline code span, as `describe()` reads a `<code class="md-code">` outside any `<pre>`. */
const codeSpan = (s: number, e: number, text: string): SrcNode => ({
  s,
  e,
  text,
  children: [],
  codeSpan: true
})

/** Slice a source the way the copy handler does, from a start and an end boundary in rendered text. */
function copy(
  source: string,
  root: SrcNode,
  from: number,
  to: number,
  context: SpanContext = { startsBefore: false, endsAfter: false }
): string {
  return resolveSpan(source, root, from, to, context)
    .map((r) => source.slice(r.s, r.e))
    .join('')
}

describe('resolveSpan — a paragraph with an inline run', () => {
  //  Some **bold text** here and more.
  //  ^0   ^5           ^18
  const SRC = 'Some **bold text** here and more.'
  const strong = node(5, 18, 'bold text')
  const para = node(0, SRC.length, 'Some bold text here and more.', [kid(5, strong)])

  it('drops the orphaned delimiter when a boundary cuts into a run', () => {
    // Selecting the rendered "ld text here" — starts mid-bold, ends in the plain text after it. The
    // closing `**` would arrive without its opener, which re-renders as a NEW bold run swallowing
    // everything after the paste. Half a styled run comes back unstyled instead.
    expect(copy(SRC, para, 7, 19)).toBe('ld text here')
  })

  it('keeps the text exact when the cut is at the other end', () => {
    expect(copy(SRC, para, 0, 10)).toBe('Some bold ')
  })

  it('closes the run when the selection began before it', () => {
    // The end boundary sits on the run's edge and the start is EARLIER, expressed as a negative offset
    // in the run's own coordinates. That has to read as "starts before me" or the closing `**` is lost.
    expect(copy(SRC, para, 0, 14)).toBe('Some **bold text**')
  })

  it('snaps outward when the selection covers exactly the run', () => {
    expect(copy(SRC, para, 5, 14)).toBe('**bold text**')
  })

  it('ends before the opening delimiter when the selection stops where the run starts', () => {
    expect(copy(SRC, para, 0, 5)).toBe('Some ')
  })

  it('starts after the closing delimiter when the selection begins where the run ends', () => {
    expect(copy(SRC, para, 14, para.text.length)).toBe(' here and more.')
  })

  it('maps a plain-text gap by verifying it against the source', () => {
    expect(copy(SRC, para, 2, 4)).toBe('me')
  })

  it('excludes the closing delimiter when the selection ends at the run but began inside it', () => {
    // Not a full-run selection, so nothing widens — and the trailing `**` must not be picked up by
    // treating the boundary as the start of the gap that follows.
    expect(copy(SRC, para, 6, 14)).toBe('old text')
  })
})

describe('resolveSpan — whole-node edges', () => {
  const SRC = '## Title'
  const heading = node(0, 8, 'Title')

  it('returns the node span for a selection covering all of its text', () => {
    // The markup a heading carries is entirely OUTSIDE its rendered text, so an exact-text selection
    // has to widen or the `##` is lost.
    expect(copy(SRC, heading, 0, 5)).toBe('## Title')
  })

  it('still maps a partial selection into the content', () => {
    expect(copy(SRC, heading, 2, 5)).toBe('tle')
  })

  it('drops the marker when the selection runs from the start but stops short', () => {
    // Same all-or-nothing rule as the fence: half a heading is not a heading.
    expect(copy(SRC, heading, 0, 4)).toBe('Titl')
  })

  it('takes the node span at BOTH edges, including markup that trails the text', () => {
    // A heading's markup is all leading, so its content end and node end coincide and the end-side
    // widen can't be observed there. Bold has a trailing `**`, which is where it shows.
    const bold = node(0, 8, 'bold')
    expect(copy('**bold**', bold, 0, 4)).toBe('**bold**')
  })
})

describe('resolveSpan — a fence keeps its delimiters only when the selection leaves the block', () => {
  // A fence as it actually renders inside a block: one annotated <pre> under the .md root, its text
  // carrying the trailing newline a drag across the visible line can never reach.
  const SRC = '```bash\n./publish release-notes\n```'
  const TEXT = './publish release-notes\n'
  const pre = { ...node(0, SRC.length, TEXT), fenced: true }
  const root = node(0, SRC.length, TEXT, [kid(0, pre)])

  it('gives bare code when the drag covers the whole visible block', () => {
    // The point of the exception: grabbing a command to run it shouldn't hand back a fence to delete.
    expect(copy(SRC, root, 0, TEXT.length - 1)).toBe('./publish release-notes')
  })

  it('gives bare code for a selection wholly inside the block', () => {
    expect(copy(SRC, root, 2, 9)).toBe('publish')
  })

  it('keeps the fence when the selection continues into a later source unit', () => {
    expect(copy(SRC, root, 0, TEXT.length - 1, { startsBefore: false, endsAfter: true })).toBe(
      SRC
    )
  })

  it('keeps the fence when the selection arrives from an earlier source unit', () => {
    expect(copy(SRC, root, 0, TEXT.length - 1, { startsBefore: true, endsAfter: false })).toBe(
      SRC
    )
  })

  it('keeps a cross-unit partial selection bare', () => {
    expect(copy(SRC, root, 2, TEXT.length - 1, { startsBefore: false, endsAfter: true })).toBe(
      'publish release-notes'
    )
    expect(copy(SRC, root, 0, 9, { startsBefore: true, endsAfter: false })).toBe('./publish')
  })

  it('never half-fences, from either edge', () => {
    expect(copy(SRC, root, 0, 9)).toBe('./publish')
    expect(copy(SRC, root, 10, TEXT.length - 1)).toBe('release-notes')
  })

  it('DOES fence once the selection reaches past the block', () => {
    // Here the fence sits between the two ends in the source, so omitting it would splice code into
    // prose. Both delimiters have to travel.
    const doc = '```bash\nls\n```\n\nThen check the output.'
    const block = { ...node(0, 14, 'ls\n'), fenced: true }
    const tail = node(16, doc.length, 'Then check the output.')
    const body = node(0, doc.length, 'ls\nThen check the output.', [kid(0, block), kid(3, tail)])
    // Rendered text is 'ls\nThen check…', so offset 8 lands just before the 'c' of "check".
    expect(copy(doc, body, 0, 8)).toBe('```bash\nls\n```\n\nThen ')
  })

  it('DOES fence when the selection arrives from prose ABOVE the block', () => {
    // The mirror of the case above. The end boundary lands at offset 11 — the last VISIBLE character,
    // one short of the block's trailing newline — so recognizing that as the block's edge is what lets
    // the closing fence travel.
    const doc = 'Run this:\n\n```bash\nls\n```'
    const lead = node(0, 9, 'Run this:')
    const block = { ...node(11, doc.length, 'ls\n'), fenced: true }
    const body = node(0, doc.length, 'Run this:ls\n', [kid(0, lead), kid(9, block)])
    // Offset 4 is the 't' of "this:" — 'Run ' occupies 0–3.
    expect(copy(doc, body, 4, 11)).toBe('this:\n\n```bash\nls\n```')
  })
})

describe('resolveSpan — an inline code span keeps its backticks only when the selection leaves the run', () => {
  // Selecting exactly a code span is the "give me the payload" gesture — a URL to open, an error string
  // to search for. Sweeping the sentence around it is the "give me the prose" gesture, and keeps markup.
  const SRC = 'Logs: `Session launch was canceled` rows'
  const TEXT = 'Logs: Session launch was canceled rows'
  const CODE = 'Session launch was canceled'
  const AT = 6
  const END = AT + CODE.length
  const para = node(0, SRC.length, TEXT, [kid(AT, codeSpan(AT, END + 2, CODE))])

  it('gives bare code when the selection covers exactly the run', () => {
    expect(copy(SRC, para, AT, END)).toBe(CODE)
  })

  it('keeps the backticks once the selection runs PAST the code into following prose', () => {
    expect(copy(SRC, para, AT, TEXT.length)).toBe('`Session launch was canceled` rows')
  })

  it('keeps the backticks when the selection arrives from prose and stops at the run’s end', () => {
    expect(copy(SRC, para, 0, END)).toBe('Logs: `Session launch was canceled`')
  })

  it('brings the backticks back on a single space of overshoot', () => {
    // The accepted cost of the strict rule: "reaches past the run" counts whitespace, so a drag that
    // releases just past the closing tick is a crossing selection. Overshooting yields MORE markup than
    // was highlighted, never a corrupt slice, which is the safe direction for the cliff to fall.
    expect(copy(SRC, para, AT, END + 1)).toBe('`Session launch was canceled` ')
  })

  it('keeps the whole block marked up for a turn or conversation copy', () => {
    expect(copy(SRC, para, 0, TEXT.length, { startsBefore: true, endsAfter: true })).toBe(SRC)
  })
})

describe('resolveSpan — a block that is nothing but an inline code span', () => {
  // `onlyCode` has to see a lone code span the way it sees a lone fence, or this block would take the
  // whole-coverage shortcut and hand back markup the rule above just declined.
  const SRC = '`npm run setup`'
  const CODE = 'npm run setup'
  const only = node(0, SRC.length, CODE, [kid(0, codeSpan(0, SRC.length, CODE))])

  it('gives bare code to a drag confined to the block', () => {
    expect(copy(SRC, only, 0, CODE.length)).toBe(CODE)
  })

  it('keeps the backticks for a copy arriving from outside the block', () => {
    expect(copy(SRC, only, 0, CODE.length, { startsBefore: true, endsAfter: true })).toBe(SRC)
  })
})

describe('resolveSpan — leaves whose text sits inside markup', () => {
  it('maps into a fenced code block past its info line', () => {
    const SRC = '```ts\nconst x = 1\n```'
    const pre = { ...node(0, SRC.length, 'const x = 1\n'), fenced: true }
    expect(copy(SRC, pre, 6, 11)).toBe('x = 1')
    // Fully covered, but confined to the block — so still bare, per the fence exception. Offset 11
    // (not 12) because the block's rendered text ends in a newline no drag can reach.
    expect(copy(SRC, pre, 0, 11)).toBe('const x = 1')
  })

  it('drops the backticks on a partial inline code selection', () => {
    const SRC = 'call `foo()` now'
    const inline = codeSpan(5, 12, 'foo()')
    const para = node(0, SRC.length, 'call foo() now', [kid(5, inline)])
    expect(copy(SRC, para, 6, 9)).toBe('oo(')
  })

  it('drops a lone backtick when the selection cuts out of inline code into prose', () => {
    // The reported case: starting inside `foo()` and running on would carry the closing tick alone.
    const SRC = 'call `foo()` now'
    const inline = codeSpan(5, 12, 'foo()')
    const para = node(0, SRC.length, 'call foo() now', [kid(5, inline)])
    expect(copy(SRC, para, 6, 14)).toBe('oo() now')
  })

  it('drops a lone backtick when the selection cuts INTO inline code from prose', () => {
    const SRC = 'call `foo()` now'
    const inline = codeSpan(5, 12, 'foo()')
    const para = node(0, SRC.length, 'call foo() now', [kid(5, inline)])
    // Offset 8 in 'call foo() now' lands after "foo", at the '('.
    expect(copy(SRC, para, 0, 8)).toBe('call foo')
  })

  it('cuts BOTH orphans when a boundary sits inside a nested run', () => {
    //  x **a `bcd` e** y   — starting inside `bcd` orphans the code's closer AND the bold's.
    //  ^0  ^2  ^6   ^13
    const SRC = 'x **a `bcd` e** y'
    const inline = codeSpan(6, 11, 'bcd')
    const bold = node(2, 15, 'a bcd e', [kid(2, inline)])
    const para = node(0, SRC.length, 'x a bcd e y', [kid(2, bold)])
    // Rendered selection is "cd e y"; the output must match it exactly, unstyled.
    expect(copy(SRC, para, 5, 11)).toBe('cd e y')
  })

  it('cuts only the outer delimiter when a run BEGINS with a nested run', () => {
    //  x **`bcd` e** y  — the bold opens straight onto the inline code, so locating the bold's own
    //  ^0  ^2^4    ^11    opening `**` must not run on and swallow the backtick with it.
    const SRC = 'x **`bcd` e** y'
    const inline = codeSpan(4, 9, 'bcd')
    const bold = node(2, 13, 'bcd e', [kid(0, inline)])
    const para = node(0, SRC.length, 'x bcd e y', [kid(2, bold)])
    expect(copy(SRC, para, 0, 5)).toBe('x `bcd`')
  })

  it('keeps a fully-covered nested run’s delimiters while cutting the outer orphan', () => {
    // Same shape, but the boundary lands ON the inline run's start — and the selection runs PAST the
    // run, so the code keeps its backticks, while the bold it sits inside is only partly covered and
    // loses its asterisks.
    const SRC = 'x **a `bcd` e** y'
    const inline = codeSpan(6, 11, 'bcd')
    const bold = node(2, 15, 'a bcd e', [kid(2, inline)])
    const para = node(0, SRC.length, 'x a bcd e y', [kid(2, bold)])
    expect(copy(SRC, para, 4, 11)).toBe('`bcd` e y')
  })

  it('maps a link whose label does not recur in its target', () => {
    const SRC = 'see [link](http://example.com) now'
    const anchor = node(4, 30, 'link')
    expect(copy(SRC, anchor, 1, 3)).toBe('in')
  })

  it('widens instead of guessing when the label also occurs in the target', () => {
    // "link" appears twice inside `[link](http://link.com)`, so its position is not provable by search.
    const SRC = 'see [link](http://link.com) now'
    const anchor = node(4, 27, 'link')
    expect(copy(SRC, anchor, 1, 3)).toBe('[link](http://link.com)')
  })

  it('widens only to the enclosing element, not the whole block', () => {
    // An unprovable mapping inside one inline run must not drag the entire paragraph along with it.
    const SRC = 'see [link](http://link.com) now and more text'
    const anchor = node(4, 27, 'link')
    const para = node(0, SRC.length, 'see link now and more text', [kid(4, anchor)])
    expect(copy(SRC, para, 5, 7)).toBe('[link](http://link.com)')
  })

  it('widens when the rendered text is nowhere in the source at all', () => {
    // An inline image renders as a chip ("🖼 alt"), which shares no substring with `![alt](url)`. Any
    // arithmetic on a failed search would silently slice from the wrong place.
    const SRC = 'see ![diagram](x.png) here'
    const chip = node(4, 21, '🖼 diagram')
    expect(copy(SRC, chip, 2, 6)).toBe('![diagram](x.png)')
  })
})

describe('resolveSpan — a list item with an inline run', () => {
  //  - one *em* item
  //  ^0    ^6  ^10
  const SRC = '- one *em* item'
  const em = node(6, 10, 'em')
  const li = node(0, 15, 'one em item', [kid(4, em)])

  it('carries the list marker when the whole item is selected', () => {
    expect(copy(SRC, li, 0, 11)).toBe('- one *em* item')
  })

  it('anchors a leading gap off the following child', () => {
    expect(copy(SRC, li, 2, 4)).toBe('e ')
  })

  it('anchors a trailing gap off the preceding child', () => {
    expect(copy(SRC, li, 7, 11)).toBe('item')
  })
})

describe('resolveSpan — markdown line containers', () => {
  it('maps a partial selection through explicit blockquote continuation markers', () => {
    const source = '> first\n> second'
    const paragraph = node(2, 16, 'first\nsecond')
    const quote = structural('blockquote', 0, 16, '\nfirst\nsecond\n', [kid(1, paragraph)])
    const root = node(0, 16, '\nfirst\nsecond\n', [kid(0, quote)])

    expect(copy(source, root, 7, 13)).toBe('second')
    expect(copy(source, root, 1, 13)).toBe(source)
  })

  it.each([' ', '  ', '   '])(
    'maps a list continuation indented by %j',
    (indent) => {
      const source = `- first\n${indent}second`
      const item = structural('list-item', 0, source.length, 'first\nsecond')
      const list = node(0, source.length, '\nfirst\nsecond\n', [kid(1, item)])
      const root = node(0, source.length, '\nfirst\nsecond\n', [kid(0, list)])

      expect(copy(source, root, 7, 13)).toBe('second')
      expect(copy(source, root, 1, 13)).toBe(source)
    }
  )

  it('maps an ordered-list continuation without losing the full-list marker', () => {
    const source = '1. first\n   second'
    const item = structural('list-item', 0, 18, 'first\nsecond')
    const list = node(0, 18, '\nfirst\nsecond\n', [kid(1, item)])
    const root = node(0, 18, '\nfirst\nsecond\n', [kid(0, list)])

    expect(copy(source, root, 7, 13)).toBe('second')
    expect(copy(source, root, 1, 13)).toBe(source)
  })

  it('preserves a fully selected list item while stripping a partial sibling', () => {
    const source = '- first\n- second'
    const first = structural('list-item', 0, 7, 'first')
    const second = structural('list-item', 8, 16, 'second')
    const list = node(0, 16, '\nfirst\nsecond\n', [kid(1, first), kid(7, second)])
    const root = node(0, 16, '\nfirst\nsecond\n', [kid(0, list)])

    expect(copy(source, root, 1, 10)).toBe('- first\nsec')
  })

  it('keeps lazy blockquote continuations on the ordinary exact-mapping path', () => {
    const source = '> first\nsecond'
    const paragraph = node(2, 14, 'first\nsecond')
    const quote = structural('blockquote', 0, 14, '\nfirst\nsecond\n', [kid(1, paragraph)])
    const root = node(0, 14, '\nfirst\nsecond\n', [kid(0, quote)])

    expect(copy(source, root, 7, 13)).toBe('second')
  })

  it('removes quote and list continuation prefixes together', () => {
    const source = '> - first\n>   second'
    const item = structural('list-item', 2, 20, 'first\nsecond')
    const list = node(2, 20, '\nfirst\nsecond\n', [kid(1, item)])
    const quote = structural('blockquote', 0, 20, '\n\nfirst\nsecond\n\n', [kid(1, list)])
    const root = node(0, 20, '\n\nfirst\nsecond\n\n', [kid(0, quote)])

    expect(copy(source, root, 8, 14)).toBe('second')
    expect(copy(source, root, 2, 14)).toBe(source)
  })

  it('strips only the partially selected owner in a nested list', () => {
    const source = '- outer\n  - inner one\n    inner two'
    const innerItem = structural('list-item', 10, 35, 'inner one\ninner two')
    const innerList = node(10, 35, '\ninner one\ninner two\n', [kid(1, innerItem)])
    const outerItem = structural('list-item', 0, 35, 'outer\n\ninner one\ninner two\n\n', [
      kid(6, innerList)
    ])
    const outerList = node(0, 35, '\nouter\n\ninner one\ninner two\n\n\n', [kid(1, outerItem)])
    const root = node(0, 35, '\nouter\n\ninner one\ninner two\n\n\n', [kid(0, outerList)])

    expect(copy(source, root, 8, 27)).toBe('- inner one\n  inner two')
    expect(copy(source, root, 24, 27)).toBe('two')
  })

  it('strips only the partially selected owner in a nested blockquote', () => {
    const source = '> outer\n>\n> > inner one\n> > inner two\n>\n> outer two'
    const innerParagraph = node(14, 37, 'inner one\ninner two')
    const innerQuote = structural('blockquote', 12, 37, '\ninner one\ninner two\n', [
      kid(1, innerParagraph)
    ])
    const outerQuote = structural(
      'blockquote',
      0,
      51,
      '\nouter\n\ninner one\ninner two\n\nouter two\n',
      [kid(1, node(2, 7, 'outer')), kid(7, innerQuote), kid(29, node(42, 51, 'outer two'))]
    )
    const root = node(0, 51, '\nouter\n\ninner one\ninner two\n\nouter two\n', [
      kid(0, outerQuote)
    ])

    expect(copy(source, root, 8, 27)).toBe('> inner one\n> inner two')
    expect(copy(source, root, 24, 27)).toBe('two')
    expect(copy(source, root, 1, 38)).toBe(source)
  })

  it('preserves paragraph separation while stripping a partial quote', () => {
    const source = '> first\n>\n> second'
    const quote = structural('blockquote', 0, 18, '\nfirst\nsecond\n', [
      kid(1, node(2, 7, 'first')),
      kid(7, node(12, 18, 'second'))
    ])
    const root = node(0, 18, '\nfirst\nsecond\n', [kid(0, quote)])

    expect(copy(source, root, 2, 10)).toBe('irst\n\nsec')
  })

  it('keeps complete inline markup while mapping across quote lines', () => {
    const source = '> first **bold**\n> second *em*'
    const strong = node(8, 16, 'bold')
    const emphasis = node(26, 30, 'em')
    const paragraph = node(2, 30, 'first bold\nsecond em', [
      kid(6, strong),
      kid(18, emphasis)
    ])
    const quote = structural('blockquote', 0, 30, '\nfirst bold\nsecond em\n', [kid(1, paragraph)])
    const root = node(0, 30, '\nfirst bold\nsecond em\n', [kid(0, quote)])

    expect(copy(source, root, 7, 18)).toBe('**bold**\nsecond')
  })

  it('still widens escaped markdown whose rendered position is ambiguous', () => {
    const source = '> x \\* y\n> second'
    const paragraph = node(2, 17, 'x * y\nsecond')
    const quote = structural('blockquote', 0, 17, '\nx * y\nsecond\n', [kid(1, paragraph)])
    const root = node(0, 17, '\nx * y\nsecond\n', [kid(0, quote)])

    expect(copy(source, root, 3, 4)).toBe('x \\* y\nsecond')
  })

  it('preserves literal indentation inside a quoted fenced block', () => {
    const source = '> before\n>\n> ```python\n> if ok:\n>     pass\n> ```\n>\n> after'
    const before = node(2, 8, 'before')
    const code = { ...node(13, 48, 'if ok:\n    pass\n'), fenced: true }
    const after = node(53, 58, 'after')
    const quote = structural(
      'blockquote',
      0,
      58,
      '\nbefore\nif ok:\n    pass\n\nafter\n',
      [kid(1, before), kid(8, code), kid(25, after)]
    )
    const root = node(0, 58, quote.text, [kid(0, quote)])

    expect(copy(source, root, 8, 23)).toBe('if ok:\n    pass')
  })

  it('preserves literal indentation inside a list-contained fenced block', () => {
    const source = '- before\n\n  ```python\n  if ok:\n      pass\n  ```\n\n  after'
    const before = node(2, 8, 'before')
    const code = { ...node(12, 47, 'if ok:\n    pass\n'), fenced: true }
    const after = node(51, 56, 'after')
    const item = structural(
      'list-item',
      0,
      56,
      '\nbefore\nif ok:\n    pass\n\nafter\n',
      [kid(1, before), kid(8, code), kid(25, after)]
    )
    const list = node(0, 56, `\n${item.text}\n`, [kid(1, item)])
    const root = node(0, 56, list.text, [kid(0, list)])

    expect(copy(source, root, 9, 24)).toBe('if ok:\n    pass')
  })

  it.each([
    ['multi-digit ordered list', '10. > first\n    > second'],
    ['extra-indented unordered list', '-   > first\n    > second']
  ])('consumes %s and quote prefixes in their actual nesting order', (_name, source) => {
    const paragraph = node(6, 24, 'first\nsecond')
    const quote = structural('blockquote', 4, 24, '\nfirst\nsecond\n', [kid(1, paragraph)])
    const item = structural('list-item', 0, 24, '\n\nfirst\nsecond\n\n', [kid(1, quote)])
    const list = node(0, 24, '\n\n\nfirst\nsecond\n\n\n', [kid(1, item)])
    const root = node(0, 24, list.text, [kid(0, list)])

    expect(copy(source, root, 9, 15)).toBe('second')
  })

  it('subtracts many structural prefixes without quadratic growth', () => {
    const lineCount = 12_000
    const lines = Array.from({ length: lineCount }, (_, i) => `line ${i}`)
    const source = lines.map((line) => `> ${line}`).join('\n')
    const rendered = lines.join('\n')
    const paragraph = node(2, source.length, rendered)
    const quote = structural('blockquote', 0, source.length, `\n${rendered}\n`, [
      kid(1, paragraph)
    ])
    const root = node(0, source.length, quote.text, [kid(0, quote)])

    const started = performance.now()
    const copied = copy(source, root, 2, root.text.length - 2)
    const elapsed = performance.now() - started

    expect(copied).toBe(rendered.slice(1, -1))
    expect(elapsed).toBeLessThan(500)
  })
})

describe('resolveSpan — hard breaks', () => {
  it.each<[string, string, number, number, string]>([
    ['backslash', 'first\\\nsecond', 5, 7, 'rst\\\nsec'],
    ['two-space', 'first  \nsecond', 5, 8, 'rst  \nsec']
  ])('maps a %s hard break outside a container', (_name, source, breakStart, breakEnd, expected) => {
    const hardBreak = structural('break', breakStart, breakEnd, '')
    const paragraph = node(0, source.length, 'first\nsecond', [kid(5, hardBreak)])
    const root = node(0, source.length, 'first\nsecond', [kid(0, paragraph)])

    expect(copy(source, root, 6, 12)).toBe('second')
    expect(copy(source, root, 2, 9)).toBe(expected)
  })

  it.each<[string, string, number, number, string]>([
    ['backslash', '> first\\\n> second', 7, 9, 'rst\\\nsec'],
    ['two-space', '> first  \n> second', 7, 10, 'rst  \nsec']
  ])('maps a %s hard break inside a blockquote', (_name, source, breakStart, breakEnd, expected) => {
    const hardBreak = structural('break', breakStart, breakEnd, '')
    const paragraph = node(2, source.length, 'first\nsecond', [kid(5, hardBreak)])
    const quote = structural(
      'blockquote',
      0,
      source.length,
      '\nfirst\nsecond\n',
      [kid(1, paragraph)]
    )
    const root = node(0, source.length, '\nfirst\nsecond\n', [kid(0, quote)])

    expect(copy(source, root, 7, 13)).toBe('second')
    expect(copy(source, root, 3, 10)).toBe(expected)
  })
})

describe('resolveSpan — unprovable mappings widen rather than mislead', () => {
  // `x \* y **z**` renders as "x * y z": the escape makes the gap one char shorter than its source.
  const SRC = 'x \\* y **z**'
  const strong = node(7, 12, 'z')
  const para = node(0, 12, 'x * y z', [kid(6, strong)])

  it('rejects a gap whose source does not match its rendered text', () => {
    // A naive anchor would land at offset 1 and slice `\* ` — wrong text, silently.
    expect(copy(SRC, para, 3, 5)).toBe(SRC)
  })

  it('still snaps correctly at the child edges either side of that gap', () => {
    expect(copy(SRC, para, 6, 7)).toBe('**z**')
  })

  it('uses a child’s own span at its edges rather than inferring from the broken gap after it', () => {
    // `x **z** \* y` renders as "x z * y". The run's own [2,7) is KNOWN, so selecting exactly it must
    // give `**z**` — even though the escaped gap that follows can't be mapped and would force a widen.
    const escaped = 'x **z** \\* y'
    const run = node(2, 7, 'z')
    const line = node(0, 12, 'x z * y', [kid(2, run)])
    expect(copy(escaped, line, 2, 3)).toBe('**z**')
  })

  it('starts from a child’s known end rather than widening when the gap after it is broken', () => {
    // Beginning exactly where the run ends is `run.e` — knowable without the gap. Inferring it from
    // the unmappable escaped gap instead would widen the start all the way to the line.
    const escaped = 'x **z** \\* y'
    const run = node(2, 7, 'z')
    const line = node(0, 12, 'x z * y', [kid(2, run)])
    expect(copy(escaped, line, 3, 7)).toBe(' \\* y')
  })
})

describe('fence', () => {
  it('wraps a body in a three-backtick fence with the language', () => {
    expect(fence('ls -la', 'bash')).toBe('```bash\nls -la\n```')
  })

  it('omits the language when none is given', () => {
    expect(fence('BUILD FAILED')).toBe('```\nBUILD FAILED\n```')
  })

  it('grows the fence past a backtick run inside the body', () => {
    // Tool output that quotes a code block back at you would otherwise close the fence early and
    // spill the remainder into the document as prose.
    expect(fence('see ```js\nx\n``` here')).toBe('````\nsee ```js\nx\n``` here\n````')
  })

  it('trims trailing whitespace so the closing fence sits tight', () => {
    expect(fence('out\n\n\n')).toBe('```\nout\n```')
  })
})

describe('assembleCopy', () => {
  const you = { label: 'You', isSidechain: false, parts: ['Why does it retry?'] }
  const claude = { label: 'Claude', isSidechain: false, parts: ['It backs off exponentially.'] }

  it('leaves a single-section selection unlabeled', () => {
    expect(assembleCopy([claude])).toBe('It backs off exponentially.')
  })

  it('labels and rules between sections once there is more than one voice', () => {
    expect(assembleCopy([you, claude])).toBe(
      '**You:**\n\nWhy does it retry?\n\n---\n\n**Claude:**\n\nIt backs off exponentially.'
    )
  })

  it('labels a lone section when the caller asks (the whole-conversation export)', () => {
    expect(assembleCopy([claude], true)).toBe('**Claude:**\n\nIt backs off exponentially.')
  })

  it('tags a sub-agent section', () => {
    expect(assembleCopy([{ label: 'Claude', isSidechain: true, parts: ['Searched.'] }], true)).toBe(
      '**Claude (Sub-agent):**\n\nSearched.'
    )
  })

  it('joins a section’s fragments with a blank line and drops empty ones', () => {
    expect(assembleCopy([{ label: 'You', isSidechain: false, parts: ['one', '   ', 'two'] }])).toBe(
      'one\n\ntwo'
    )
  })

  it('drops sections that contributed nothing, rather than emitting an empty label', () => {
    expect(assembleCopy([{ label: 'You', isSidechain: false, parts: ['  '] }, claude])).toBe(
      'It backs off exponentially.'
    )
  })

  it('returns empty when nothing survived', () => {
    expect(assembleCopy([{ label: 'You', isSidechain: false, parts: ['', ' '] }])).toBe('')
  })

  it('unbolds the speaker labels in plain mode but keeps the attribution', () => {
    // Attribution is structure, not styling — a plain-text copy still needs to say who said what.
    expect(assembleCopy([you, claude], false, true)).toBe(
      'You:\n\nWhy does it retry?\n\n---\n\nClaude:\n\nIt backs off exponentially.'
    )
  })

  it('preserves leading and trailing table columns in plain mode', () => {
    expect(
      assembleCopy(
        [{ label: 'Claude', isSidechain: false, parts: [' \n\tvalue\t\n '] }],
        false,
        true
      )
    ).toBe('\tvalue\t')
  })
})
