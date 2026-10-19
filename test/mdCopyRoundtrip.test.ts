import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { copyText, serializeCopy, type CopyNode, type CopySelection } from '../src/renderer/lib/mdCopy'
import { markdownCopyNodes } from '../src/renderer/lib/mdCopyAst'

interface ParsedNode { type: string; value?: string; url?: string; title?: string | null; children?: ParsedNode[] }
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const parse = (source: string): ParsedNode => parser.parse(source) as ParsedNode
// remark-math pairs any two single dollars; copy follows the stricter shared convention, so its
// single-dollar cases are asserted as exact strings and this parser checks everything else.
const strictParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false })
const parseStrict = (source: string): ParsedNode => strictParser.parse(source) as ParsedNode
const complete = (nodes: CopyNode[], mode: 'markdown' | 'plain' = 'markdown'): string =>
  serializeCopy(nodes, { mode, intent: 'complete' })
function characters(node: ParsedNode, styles = 0): { text: string; styles: number }[] {
  const inherited = styles | (node.type === 'emphasis' ? 1 : node.type === 'strong' ? 2 : node.type === 'delete' ? 4 : 0)
  if (node.type === 'break') return [{ text: '\n', styles: inherited }]
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') return Array.from(node.value ?? '', text => ({ text, styles: inherited }))
  return (node.children ?? []).flatMap(child => characters(child, inherited))
}
function types(node: ParsedNode): string[] {
  return [node.type, ...(node.children ?? []).flatMap(types)]
}
function values(node: ParsedNode, kind: string): string[] {
  return node.type === kind ? [node.value ?? ''] : (node.children ?? []).flatMap(child => values(child, kind))
}
function styled(text: string, styles: number): CopyNode {
  let node: CopyNode = copyText(text)
  if (styles & 1) node = { kind: 'em', children: [node] }
  if (styles & 2) node = { kind: 'strong', children: [node] }
  if (styles & 4) node = { kind: 'strike', children: [node] }
  return node
}
const paragraph = (children: CopyNode[]): CopyNode => ({ kind: 'paragraph', children })

describe('retained inline formatting round-trips', () => {
  it('preserves text and per-character styles for all 4096 four-run combinations', () => {
    for (let pattern = 0; pattern < 4096; pattern++) {
      const runs = Array.from('abcd', (text, index) => ({ text, styles: (pattern >> (index * 3)) & 7 }))
      const copied = complete([paragraph(runs.map(run => styled(run.text, run.styles)))])
      expect(characters(parse(copied)), `pattern ${pattern}: ${copied}`).toEqual(runs)
    }
  })
  it.each([
    'L **_a_***_b_* R', 'L **_a_**_~~b~~_ R',
    'L **_aa_***_bb_* R', 'L *~~a~~* **_b_** R',
    'L **alpha *beta* gamma** R', 'L **a** __b__ R',
    'L **`code`** *[link](https://example.org)* R'
  ])('preserves the visible styles in %s', source => {
    const copied = complete(markdownCopyNodes(source))
    expect(characters(parse(copied))).toEqual(characters(parse(source)))
    expect(values(parse(copied), 'inlineCode')).toEqual(values(parse(source), 'inlineCode'))
    expect(types(parse(copied)).filter(type => type === 'link')).toEqual(types(parse(source)).filter(type => type === 'link'))
  })
})

describe('style-boundary whitespace', () => {
  const contentStyles = (source: string) => characters(parse(source)).map(char =>
    /\s/.test(char.text) ? { ...char, styles: 0 } : char)
  it.each([
    ['L ~~a *b*~~ R', 'L ~~a~~ *~~b~~* R'],
    ['L ~~*a* b~~ R', 'L *~~a~~* ~~b~~ R'],
    ['L ~~a **b** c~~ R', 'L ~~a~~ **~~b~~** ~~c~~ R'],
    ['L ~~a\u00a0_b_~~ R', 'L ~~a~~\u00a0*~~b~~* R']
  ])('keeps nested strike content intact in %s', (source, expected) => {
    expect((characters(parse(source)).find(char => char.text === 'a')?.styles ?? 0) & 4).toBe(4)
    expect((characters(parse(source)).find(char => char.text === 'b')?.styles ?? 0) & 4).toBe(4)
    const copied = complete(markdownCopyNodes(source))
    expect(copied).toBe(expected)
    expect(contentStyles(copied)).toEqual(contentStyles(source))
    expect(complete(markdownCopyNodes(source), 'plain')).toBe(characters(parse(source)).map(char => char.text).join(''))
  })
  it('preserves characters and non-whitespace styles across 500 source-derived boundaries', () => {
    const markers = ['*', '_', '**', '__', '~~']
    let checked = 0
    for (const outer of markers) for (const inner of markers) for (const gap of [' ', '. ', '! ', '\u00a0', '\n']) {
      for (const body of ['a' + gap + inner + 'b' + inner, inner + 'a' + inner + gap + 'b',
        'a' + gap + inner + 'b' + inner + gap + 'c', inner + 'a' + inner + gap + inner + 'b' + inner]) {
        const source = 'L ' + outer + body + outer + ' R'
        const copied = complete(markdownCopyNodes(source))
        expect(contentStyles(copied), source + ' -> ' + copied).toEqual(contentStyles(source))
        checked++
      }
    }
    expect(checked).toBe(500)
  })
  it.each(['L ~~a b~~ R', 'L **alpha *beta* gamma** R', 'L *a b* R'])('retains internal space styling in %s', source => {
    expect(characters(parse(complete(markdownCopyNodes(source))))).toEqual(characters(parse(source)))
  })
  it('keeps whitespace-only bodies without empty formatting markers', () => {
    expect(complete([paragraph([styled(' \t\u00a0\n ', 7), copyText('x')])])).toBe(' \t\u00a0\n x')
  })
  it('leaves padding inside code and math payloads alone', () => {
    const nodes: CopyNode[] = [paragraph([{ kind: 'strong', children: [
      { kind: 'code', value: ' a ', block: false }, copyText(' '), { kind: 'math', value: ' b ', display: false }
    ] }])]
    const copied = complete(nodes)
    // Math parsing strips delimiter padding; the emitted atomic payload must stay byte-for-byte.
    expect(copied).toBe('**`  a  ` $ b $**')
    expect(values(parse(copied), 'inlineCode')).toEqual([' a '])
  })
})

function metadata(node: ParsedNode): { type: string; url: string; title: string | null }[] {
  return node.type === 'link' || node.type === 'image'
    ? [{ type: node.type, url: node.url!, title: node.title ?? null }]
    : (node.children ?? []).flatMap(metadata)
}
describe.each(['link', 'image'] as const)('%s metadata escaping', kind => {
  it.each([
    [String.raw`https://example.org/\&copy;`, String.raw`a\&copy;`, 'https://example.org/&copy;', 'a&copy;'],
    [String.raw`https://example.org/a\<b\>c`, 'angle < title >', 'https://example.org/a<b>c', 'angle < title >'],
    [String.raw`https://example.org/a\\b`, String.raw`say \"hi\" \\ ok`, 'https://example.org/a\\b', 'say "hi" \\ ok'],
    [String.raw`https://example.org/?a=1\&b=2\&#65;`, String.raw`number \&#65;`, 'https://example.org/?a=1&b=2&#65;', 'number &#65;']
  ])('preserves the decoded destination and title for %s', (destination, title, url, decodedTitle) => {
    const source = 'L ' + (kind === 'image' ? '!' : '') + '[label](<' + destination + '> "' + title + '") R'
    const expected = [{ type: kind, url, title: decodedTitle }]
    expect(metadata(parse(source))).toEqual(expected)
    const copied = complete(markdownCopyNodes(source))
    expect(metadata(parse(copied))).toEqual(expected)
    expect(complete(markdownCopyNodes(source), 'plain')).toBe('L label R')
  })
})

describe('emitted delimiter context', () => {
  const semantic = (source: string) => characters(parse(source)).map(char =>
    /\s/.test(char.text) ? { ...char, styles: 0 } : char)
  it.each([
    'x*_a*y', 'x**~a**', 'L *a*\\*b R', 'L ~~a~~\\~b R', 'L \\*b*a* R', 'L *a*__.__ R',
    'x*a*__.__ R', 'L __.__*a*y', 'α*_a*y', '𝔸*_a*y', '🐈*_a*y', 'x*a_**b*𝔸',
    'L [x*_a*y](https://example.org) R', 'L **[x*_a*y](https://example.org)** R',
    'L **`_a*`** R', 'L *`a\\b`* R',
    '&#120;**`_a*`**&#121;', '&#120;*[a](https://example.org)*&#121;'
  ])('preserves text and eligible styles for %s', source => {
    const before = semantic(source)
    expect(before.some(char => char.styles !== 0)).toBe(true)
    const copied = complete(markdownCopyNodes(source))
    expect(semantic(copied)).toEqual(before)
    expect(metadata(parse(copied))).toEqual(metadata(parse(source)))
  })
  it('propagates a repair back across a previously checked boundary', () => {
    expect(complete(markdownCopyNodes('x*a*__.__ R'))).toBe('&#120;*&#97;***.** R')
  })
  it('checks punctuation-bearing content in varied surrounding contexts', () => {
    let styledCases = 0, bareCases = 0, blockCases = 0
    for (const marker of ['*', '_', '**', '__', '~~']) for (const body of ['_a', '~a', '.', 'a.', 'a_', 'a~', 'a*b', 'a\\b', 'a', 'a b']) {
      for (const [left, right] of [['L ', ' R'], ['x', 'y'], ['', ''], ['.', '!'], ['α', 'β'], ['𝔸', '𝔹'], ['🐈', '🐕']]) {
        const source = left + marker + body + marker + right
        // A run of tildes at column zero can be a fence, not an inline delimiter example.
        if (parse(source).children?.[0]?.type !== 'paragraph') { blockCases++; continue }
        const before = semantic(source), copied = complete(markdownCopyNodes(source))
        if (before.some(char => char.styles)) {
          expect(semantic(copied), source + ' -> ' + copied).toEqual(before)
          styledCases++
        } else {
          // Literal-only passages deliberately keep visible bytes, even when a destination parses them.
          expect(copied).toBe(before.map(char => char.text).join(''))
          bareCases++
        }
      }
    }
    expect(styledCases).toBeGreaterThan(150)
    expect(bareCases).toBeGreaterThan(0)
    expect(styledCases + bareCases + blockCases).toBe(350)
  })
  it('escapes only syntax-forming literals, and only in a mixed passage', () => {
    const source = 'Before (v2.1): **bold** after! *x*'
    expect(complete(markdownCopyNodes(source))).toBe('Before (v2.1): **bold** after! *x*')
    expect(complete(markdownCopyNodes('Before \\*x\\*: **bold**'))).toBe('Before \\*x\\*: **bold**')
    expect(complete(markdownCopyNodes(source), 'plain')).toBe('Before (v2.1): bold after! x')
    const literal = copyText('*literal* (v2.1)')
    expect(serializeCopy([paragraph([literal])], { mode: 'markdown', intent: 'selection',
      selection: new Map([[literal, { from: 0, to: 16 }]]) })).toBe('*literal* (v2.1)')
  })
  it('protects literal markers in neighboring TSV cells', () => {
    const table: CopyNode = { kind: 'table', align: [], children: [
      { kind: 'row', children: [{ kind: 'cell', children: [copyText('*prefix')] },
        { kind: 'cell', children: [styled('a', 1)] }, { kind: 'cell', children: [copyText('tail*')] }] }
    ] }
    const selection = new Map()
    for (const cell of 'children' in table.children[0] ? table.children[0].children : []) {
      if ('children' in cell) for (const node of cell.children) {
        const leaf = 'children' in node ? node.children[0] : node
        selection.set(leaf, { from: 0, to: 'value' in leaf ? leaf.value.length : 0 })
      }
    }
    const copied = serializeCopy([table], { mode: 'markdown', intent: 'selection', selection })
    expect(copied).toBe('\\*prefix\t*a*\ttail\\*')
    expect(semantic(copied).filter(char => char.styles)).toEqual([{ text: 'a', styles: 1 }])
    expect(serializeCopy([table], { mode: 'plain', intent: 'selection', selection })).toBe('*prefix\ta\ttail*')
  })
})

describe('consecutive retained hard breaks', () => {
  it.each([1, 2, 3])('keeps %i trailing selected breaks as literal newlines', count => {
    for (const body of ['**AlphaBREAKSBravo**', '*AlphaBREAKSBravo*', '[AlphaBREAKSBravo](https://example.org)',
      '- AlphaBREAKSBravo', '> AlphaBREAKSBravo']) {
      const source = body.replace('BREAKS', '\\\n'.repeat(count).replace(/\n/g, body.startsWith('- ') ? '\n  ' : body.startsWith('> ') ? '\n> ' : '\n'))
      const nodes = markdownCopyNodes(source), selection: CopySelection = new Map()
      const visit = (node: CopyNode): void => {
        if (node.kind === 'text' && node.value === 'Alpha') selection.set(node, { from: 0, to: 5 })
        if (node.kind === 'break') selection.set(node, { from: 0, to: 1 })
        if ('children' in node) node.children.forEach(visit)
      }
      nodes.forEach(visit)
      expect(types(parse(source)).filter(type => type === 'break')).toHaveLength(count)
      for (const mode of ['markdown', 'plain'] as const) {
        const copied = serializeCopy(nodes, { mode, intent: 'selection', selection })
        expect(copied).toBe('Alpha' + '\n'.repeat(count))
        // Markdown discards terminal empty lines; the clipboard still retains every selected LF.
        expect(characters(parse(copied))).toEqual(Array.from('Alpha', text => ({ text, styles: 0 })))
        expect(types(parse(copied)).filter(type => type === 'break')).toHaveLength(0)
      }
    }
  })
  it.each([1, 2, 3])('preserves %i breaks inside styles, links and lists', count => {
    const breaks = '\\\n'.repeat(count)
    for (const source of ['L **Alpha' + breaks + 'Bravo** R', 'L *Alpha' + breaks + 'Bravo* R',
      'L [Alpha' + breaks + 'Bravo](https://example.org) R', '- Alpha' + breaks.replace(/\n/g, '\n  ') + 'Bravo\n- second']) {
      const copied = complete(markdownCopyNodes(source))
      expect(types(parse(source)).filter(type => type === 'break')).toHaveLength(count)
      expect(types(parse(copied)).filter(type => type === 'break')).toHaveLength(count)
      expect(characters(parse(copied))).toEqual(characters(parse(source)))
      expect(metadata(parse(copied))).toEqual(metadata(parse(source)))
    }
  })
  it('does not let a literal backslash absorb a generated hard break', () => {
    const source = String.raw`L \\` + '  \nBravo'
    const copied = complete(markdownCopyNodes(source))
    expect(types(parse(copied)).filter(type => type === 'break')).toHaveLength(1)
    expect(characters(parse(copied))).toEqual(characters(parse(source)))
  })
})

describe('adjacent retained code and math', () => {
  it.each(['code', 'math'] as const)('preserves separate %s atoms under equivalent styles', kind => {
    for (const styles of [1, 2, 3, 5, 6, 7]) for (const count of [2, 3, 4]) {
      const atom = (value: string) => kind === 'code' ? '`' + value + '`' : '$' + value + '$'
      const bodies = Array.from({ length: count }, (_, index) => {
        let body = atom(String.fromCharCode(97 + index))
        if (styles & 4) body = '~~' + body + '~~'
        const marker = index % 2 ? '_' : '*'
        if (styles & 2) body = marker.repeat(2) + body + marker.repeat(2)
        if (styles & 1) body = marker + body + marker
        return body
      })
      const source = 'L ' + bodies.join('') + ' R' + (kind === 'math' ? '\n\n$$\nx\n$$' : '')
      const before = parse(source).children![0]
      const nodes = markdownCopyNodes(source).slice(0, 1)
      const expected = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index))
      const type = kind === 'code' ? 'inlineCode' : 'inlineMath'
      expect(values(before, type), source).toEqual(expected)
      for (const intent of ['complete', 'selection'] as const) {
        const selection: CopySelection = new Map()
        const visit = (node: CopyNode): void => {
          if ('value' in node) selection.set(node, { from: 0, to: node.value.length })
          if ('children' in node) node.children.forEach(visit)
        }
        nodes.forEach(visit)
        const copied = serializeCopy(nodes, { mode: 'markdown', intent, selection })
        expect(values(parse(copied), type), copied).toEqual(expected)
        expect(characters(parse(copied)), copied).toEqual(characters(before))
      }
    }
  })
  it('keeps payload backticks intact when separating padded code spans', () => {
    const source = 'L *`` a` ``*_`` `b ``_ R'
    const copied = complete(markdownCopyNodes(source))
    expect(values(parse(source), 'inlineCode')).toEqual(['a`', '`b'])
    expect(values(parse(copied), 'inlineCode')).toEqual(['a`', '`b'])
    expect(characters(parse(copied))).toEqual(characters(parse(source)))
  })
})

describe('empty destinations and title line endings', () => {
  it.each(['link', 'image'] as const)('preserves decoded %s destination line endings', kind => {
    for (const [encoded, ending] of [['&#10;', '\n'], ['&#13;', '\r'], ['&#13;&#10;', '\r\n']]) {
      const source = 'L ' + (kind === 'image' ? '!' : '') + '[label](<a' + encoded + 'b\\&copy;\\&#10;> "title") R'
      const expected = [{ type: kind, url: 'a' + ending + 'b&copy;&#10;', title: 'title' }]
      expect(metadata(parse(source))).toEqual(expected)
      const copied = complete(markdownCopyNodes(source))
      expect(copied).not.toMatch(/[\r\n]/)
      expect(metadata(parse(copied))).toEqual(expected)
    }
  })
  it('retains an empty image destination and its title', () => {
    const source = 'L ![label](<> "title") R'
    expect(metadata(parse(source))).toEqual([{ type: 'image', url: '', title: 'title' }])
    expect(complete(markdownCopyNodes(source))).toBe(source)
    expect(complete([paragraph([copyText('L '), { kind: 'image', value: 'uploaded' }, copyText(' R')])])).toBe('L uploaded R')
  })
  it.each(['link', 'image'])('preserves %s title line endings and literal character references', kind => {
    for (const ending of ['\n', '\r', '\r\n']) {
      const title = 'line' + ending + 'break &copy; &#10;'
      const source = 'L ' + (kind === 'image' ? '!' : '') + '[label](<> "line' + ending + 'break \\&copy; \\&#10;") R'
      const expected = [{ type: kind, url: '', title }]
      expect(metadata(parse(source))).toEqual(expected)
      const copied = complete(markdownCopyNodes(source))
      expect(copied).not.toMatch(/[\r\n]/)
      expect(metadata(parse(copied))).toEqual(expected)
    }
  })
})

describe('literal punctuation inside retained Markdown', () => {
  it.each(['~~bar~~', '&copy;', '# heading', '> quote', '- nested', '+ nested', '1. nested', '1) nested', '<b>text</b>',
    '***', '===', 'a|b', 'a\\|b', '[x] unchecked', '$x$'])('preserves %s without inventing syntax', value => {
    const list: CopyNode = { kind: 'list', start: null, children: [
      { kind: 'item', children: [copyText(value)] }, { kind: 'item', children: [copyText('second')] }
    ] }
    const copied = complete([list]), parsed = parse(copied)
    expect(characters(parsed).map(char => char.text).join('')).toBe(value + 'second')
    expect(types(parsed)).toEqual(['root', 'list', 'listItem', 'paragraph', 'text', 'listItem', 'paragraph', 'text'])
    expect(complete([list], 'plain')).toBe('- ' + value + '\n- second')
  })
  it('preserves a complete ASCII punctuation string in retained text', () => {
    const value = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
    const copied = complete([paragraph([{ kind: 'strong', children: [copyText(value)] }])])
    expect(characters(parse(copied))).toEqual(Array.from(value, text => ({ text, styles: 2 })))
  })
  it('leaves bare punctuation literal', () => {
    const text = copyText('~~a~~ &copy; # b | c \\d')
    expect(serializeCopy([paragraph([text])], {
      mode: 'markdown', intent: 'selection', selection: new Map([[text, { from: 0, to: 23 }]])
    })).toBe('~~a~~ &copy; # b | c \\d')
  })
})

describe('table pipe escaping', () => {
  it.each([0, 1, 2])('preserves text, code and math from a table with %i backslash pairs', pairs => {
    const value = 'a' + '\\'.repeat(pairs) + '|b'
    // GFM removes one protecting slash in code, while math retains its source verbatim.
    const codeValue = 'a' + '\\'.repeat(pairs * 2) + '|b'
    const mathValue = 'a' + '\\'.repeat(pairs * 2 + 1) + '|b'
    const table: CopyNode = { kind: 'table', align: [], children: [
      { kind: 'row', children: ['Text', 'Bold', 'Code', 'Math'].map(title => ({ kind: 'cell', children: [copyText(title)] })) },
      { kind: 'row', children: [
        { kind: 'cell', children: [copyText(value)] },
        { kind: 'cell', children: [{ kind: 'strong', children: [copyText(value)] }] },
        { kind: 'cell', children: [{ kind: 'code', value: codeValue, block: false }] },
        { kind: 'cell', children: [{ kind: 'math', value: mathValue, display: false }] }
      ] }
    ] }
    const copied = complete([table]), parsed = parse(copied)
    expect(types(parsed).filter(type => type === 'tableCell')).toHaveLength(8)
    expect(values(parsed, 'text')).toEqual(['Text', 'Bold', 'Code', 'Math', value, value])
    expect(values(parsed, 'inlineCode')).toEqual([codeValue])
    expect(values(parsed, 'inlineMath')).toEqual([mathValue])
  })
})

describe('flow boundaries', () => {
  it.each(['markdown', 'plain'] as const)('keeps adjacent literal HTML and their selected newline together in %s', mode => {
    const nodes: CopyNode[] = [{ kind: 'flow', children: [copyText('<div>alpha</div>'), copyText('\n'), copyText('<div>beta</div>')] }]
    expect(complete(nodes, mode)).toBe('<div>alpha</div>\n<div>beta</div>')
  })
  it('separates blocks while preserving inline whitespace', () => {
    const nodes: CopyNode[] = [{ kind: 'flow', children: [copyText('alpha '), copyText(' beta'),
      paragraph([copyText('middle')]), copyText('gamma\n'), copyText('delta')] }]
    expect(complete(nodes)).toBe('alpha  beta\n\nmiddle\n\ngamma\ndelta')
  })
  it('does not add boundaries for unselected blocks', () => {
    const left = copyText('a'), right = copyText('b')
    const node: CopyNode = { kind: 'flow', children: [left, paragraph([copyText('hidden')]), right] }
    expect(serializeCopy([node], { mode: 'plain', intent: 'selection', selection: new Map([
      [left, { from: 0, to: 1 }], [right, { from: 0, to: 1 }]
    ]) })).toBe('ab')
  })
})

describe('minimal literal escaping', () => {
  const strong = (text: string): CopyNode => ({ kind: 'strong', children: [copyText(text)] })
  // The literal leads the passage, so line-start rules apply; the bold neighbor makes it a mixed passage.
  const leading = (text: string): string => complete([paragraph([copyText(text), strong('B')])])
  const trailing = (text: string): string => complete([paragraph([strong('B'), copyText(text)])])
  const roundTrips = (copied: string, text: string, first: boolean): void =>
    expect(characters(parseStrict(copied)), copied).toEqual(first
      ? [...Array.from(text, char => ({ text: char, styles: 0 })), { text: 'B', styles: 2 }]
      : [{ text: 'B', styles: 2 }, ...Array.from(text, char => ({ text: char, styles: 0 }))])

  it('leaves prose punctuation bare', () => {
    const text = "Content: five points (each labeled), the repo's \"README\" - done! a+b=c? x@y/z ^{}; "
    expect(leading(text)).toBe(text + '**B**')
    roundTrips(leading(text), text, true)
  })
  it.each([
    ['a `b` c ', 'a \\`b\\` c '], ['a *b* c ', 'a \\*b\\* c '], ['5 * 3 ', '5 * 3 '], ['ses-* pods ', 'ses-* pods '],
    ['a [b] c ', 'a [b] c '], ['a [b](c) ', 'a [b\\](c) '], ['a [b][c] ', 'a [b\\][c] '],
    ['a \\. c ', 'a \\\\. c '], ['a \\b c ', 'a \\b c '], ['a \\', 'a \\\\'], ['a \\b', 'a \\\\b'],
    ['use snake_case_name here ', 'use snake_case_name here '], ['a _b_ c ', 'a \\_b\\_ c '], ['a_ ', 'a_ '],
    ['keep _private here ', 'keep _private here '],
    ['a <b> c ', 'a \\<b> c '], ['a </b c ', 'a </b c '], ['if a <b and c ', 'if a <b and c '],
    ['a <x@y.z> c ', 'a \\<x@y.z> c '], ['a <+x@y.co> c ', 'a \\<+x@y.co> c '],
    ['a < b <= c ', 'a < b <= c '], ['a &amp; c ', 'a \\&amp; c '], ['a &#38; &#x26; ', 'a \\&#38; \\&#x26; '],
    ['a & b &c ', 'a & b &c '], ['cost $5 ', 'cost $5 '], ['$5 or $6 ', '$5 or $6 '], ['x$5 ', 'x$5 '],
    ['the $x$ mark ', 'the \\$x\\$ mark '], ['$a b$ c ', '\\$a b\\$ c '], ['$a b$5 ', '$a b$5 '], ['$$x$$ ', '\\$\\$x\\$\\$ '],
    ['a $ b$ c ', 'a $ b$ c '], ['pay $a or $ b ', 'pay $a or $ b '],
    // An emphasis run beside another marker character can open or close regardless of flanking.
    ['x*_a b* ', 'x\\*_a b\\* '], ['*a _*x ', '\\*a _\\*x '], ['use snake_case and x_ ', 'use snake_case and x_ '],
    ['a ~~~b c~~~ d ', 'a ~~~b c~~~ d '], ['a <b c> d ', 'a \\<b c> d '],
    ['~/path ', '~/path '], ['~/a and ~/b ', '~/a and ~/b '], ['~40 and ~12 ', '~40 and ~12 '], ['x ~a~ y ', 'x \\~a\\~ y '],
    ['x ~~a~~ y ', 'x \\~\\~a\\~\\~ y '], ['see issue # ', 'see issue # ']
  // Titles avoid `%j`: vitest would also interpolate the `$` inside the data.
  ])('escapes only syntax-forming inline literals (case %#)', (text, expected) => {
    expect(leading(text)).toBe(expected + '**B**')
    roundTrips(leading(text), text, true)
  })
  it.each([
    ['# a ', '\\# a '], ['#tag ', '#tag '], ['> a ', '\\> a '], ['- a ', '\\- a '], ['+ a ', '\\+ a '],
    ['-a ', '-a '], ['1. a ', '1\\. a '], ['1) a ', '1\\) a '], ['1.5 a ', '1.5 a '],
    ['p\n- a ', 'p\n\\- a '], ['p\n---\n', 'p\n\\---\n'], ['p\n===\n', 'p\n\\===\n'],
    ['a | b\n-|-\n', 'a | b\n\\-|-\n'], ['p\n  > a ', 'p\n  \\> a '], ['mid - a > b # c 1. ', 'mid - a > b # c 1. '],
    ['p\n5. a ', 'p\n5. a '], ['p\n1. a ', 'p\n1\\. a '], ['5. a ', '5\\. a '], ['p\n\n5. a ', 'p\n\n5\\. a '],
    ['p\n***\n', 'p\n\\*\\*\\*\n'], ['p\n___\n', 'p\n\\_\\_\\_\n'], ['p\n* * *\n', 'p\n\\* * *\n'],
    ['p\n~~~\n', 'p\n\\~\\~\\~\n'], ['p\n$$\n', 'p\n\\$\\$\n'], ['p\n<div class ', 'p\n\\<div class '],
    ['[x] task ', '\\[x] task '], ['[r]: /x ', '\\[r]: /x ']
  ])('escapes only syntax-forming line starts (case %#)', (text, expected) => {
    expect(leading(text)).toBe(expected + '**B**')
    expect(types(parseStrict(leading(text))).filter(type => !['root', 'paragraph', 'text', 'strong'].includes(type))).toEqual([])
  })
  it('protects an autolink that would span a generated marker', () => {
    const copied = complete([paragraph([copyText('a <+'), strong('b'), copyText('@x.co> c')])])
    expect(copied).toBe('a \\<+**b**@x.co> c')
    expect(types(parse(copied))).not.toContain('link')
  })
  it('decides escaping across adjacent literal nodes', () => {
    const copied = complete([paragraph([copyText('a &amp'), copyText('; b '), strong('B')])])
    expect(copied).toBe('a \\&amp; b **B**')
    expect(characters(parse(copied)).map(char => char.text).join('')).toBe('a &amp; b B')
  })
  it('leaves block syntax bare where only inline content can follow', () => {
    const heading: CopyNode = { kind: 'heading', level: 3, children: [copyText('1. Prose - and > more '), strong('B')] }
    expect(complete([heading])).toBe('### 1. Prose - and > more **B**')
    const cell = (children: CopyNode[]): CopyNode => ({ kind: 'cell', children })
    const table: CopyNode = { kind: 'table', align: [], children: [
      { kind: 'row', children: [cell([copyText('H')]), cell([copyText('I')])] },
      { kind: 'row', children: [cell([copyText('- a')]), cell([copyText('# b '), strong('B')])] }] }
    expect(complete([table])).toContain('| - a | # b **B** |')
    // A bare heading body pastes as an ordinary line, where the same text would start a list.
    const bare: CopyNode = { kind: 'heading', level: 3, children: [copyText('1. Prose '), strong('B')] }
    const selection: CopySelection = new Map([[bare.children[0], { from: 0, to: 9 }],
      ['children' in bare.children[1] ? bare.children[1].children[0] : bare.children[1], { from: 0, to: 1 }]])
    expect(serializeCopy([bare], { mode: 'markdown', intent: 'selection', selection })).toBe('1\\. Prose **B**')
  })
  it('escapes block syntax after a retained hard break', () => {
    const copied = complete([paragraph([strong('B'), { kind: 'break' }, copyText('- a '), strong('C')])])
    expect(copied).toBe('**B**\\\n\\- a **C**')
    expect(types(parse(copied))).not.toContain('list')
  })
  it('escapes a final number-sign run that a heading would strip', () => {
    const heading: CopyNode = { kind: 'heading', level: 2, children: [strong('B'), copyText(' issue #')] }
    expect(complete([heading])).toBe('## **B** issue \\#')
    expect(characters(parse(complete([heading]))).map(char => char.text).join('')).toBe('B issue #')
    expect(trailing(' C# and #x')).toBe('**B** C# and #x')
  })
  it('pairs single dollars by the shared math convention, through atoms and link metadata', () => {
    const math: CopyNode = { kind: 'math', value: 'x', display: false }
    expect(complete([paragraph([math, copyText(' costs $5')])])).toBe('$x$ costs $5')
    expect(complete([paragraph([math, copyText(' costs 5$ more')])])).toBe('$x$ costs 5\\$ more')
    expect(complete([paragraph([{ kind: 'code', value: 'echo $HOME', block: false }, copyText(' costs $5')])]))
      .toBe('`echo $HOME` costs $5')
    // A math opener scans through a code span or link destination for its closer.
    expect(complete([paragraph([{ kind: 'code', value: 'x$y', block: false }, copyText(' then b$ end')])]))
      .toBe('`x$y` then b\\$ end')
    expect(complete([paragraph([{ kind: 'link', url: 'https://x.test/$a', children: [copyText('l')] }, copyText(' then b$ end')])]))
      .toBe('[l](https://x.test/$a) then b\\$ end')
  })
  it('treats a digit that boundary repair will encode as no longer blocking a closing dollar', () => {
    // The opener after `1` is not left-flanking, so the `1` becomes a reference that no longer follows the `$`.
    expect(complete([paragraph([copyText('$a b$1'), strong('.x')])])).toBe('\\$a b\\$&#49;**.x**')
  })
  it('escapes a tilde that touches a strike marker, but not one that only shares the passage', () => {
    const strike: CopyNode = { kind: 'strike', children: [copyText('s')] }
    expect(complete([paragraph([strike, copyText('~x')])])).toBe('~~s~~\\~x')
    expect(complete([paragraph([strike, copyText(' ~/a')])])).toBe('~~s~~ ~/a')
    // Strikethrough pairs equal runs only, so a lone opener cannot reach the marker's closer.
    expect(complete([paragraph([copyText('a ~/b '), strike])])).toBe('a ~/b ~~s~~')
    expect(complete([paragraph([{ kind: 'code', value: '~/b', block: false }, copyText(' a~ b')])])).toBe('`~/b` a~ b')
  })
  it('lets a marker character beside an emphasis run make it a closer', () => {
    // No generated asterisk follows, so only the neighboring underscore makes the second asterisk close.
    const copied = complete([paragraph([copyText('*a _*x '), { kind: 'strike', children: [copyText('s')] }])])
    expect(copied).toBe('\\*a _\\*x ~~s~~')
    expect(types(parseStrict(copied))).not.toContain('emphasis')
  })
  it('lets emphasis inside code and link metadata stay out of pairing', () => {
    expect(complete([paragraph([copyText('a *b '), { kind: 'code', value: 'c*', block: false }])])).toBe('a *b `c*`')
    expect(complete([paragraph([copyText('a *b '), strong('B')])])).toBe('a \\*b **B**')
  })
  it('escapes entity-shaped ampersands only in link metadata', () => {
    const link: CopyNode = { kind: 'link', url: 'https://x.test/?a=1&b=2&amp;', title: 'T & U &copy;', children: [copyText('l')] }
    const copied = complete([paragraph([copyText('L '), link])])
    expect(copied).toBe('L [l](https://x.test/?a=1&b=2\\&amp; "T & U \\&copy;")')
    const parsed = parse(copied).children?.[0]?.children?.[1]
    expect([parsed?.url, parsed?.title]).toEqual(['https://x.test/?a=1&b=2&amp;', 'T & U &copy;'])
  })
  it.each([
    ['https://x.test/a_(b)', '(https://x.test/a_(b))'], ['https://x.test/a\\b', '(https://x.test/a\\\\b)'],
    ['https://x.test/a b', '(<https://x.test/a b>)'], ['https://x.test/a_(b', '(<https://x.test/a_(b>)'],
    ['https://x.test/a)b(', '(<https://x.test/a)b(>)'], ['https://x.test/<a>', '(https://x.test/<a>)'],
    ['<x', '(<\\<x>)'], ['https://x.test/a\\(b)', '(https://x.test/a\\\\(b))'],
    ['https://x.test/a\tb', '(<https://x.test/a\tb>)'], ['', '(<>)']
  ])('writes the destination %j bare unless it needs brackets', (url, expected) => {
    const copied = complete([paragraph([copyText('L '), { kind: 'link', url, children: [copyText('l')] }])])
    expect(copied).toBe('L [l]' + expected)
    expect(parse(copied).children?.[0]?.children?.[1]?.url).toBe(url)
  })
  it('keeps an empty destination bracketed so a title cannot become the URL', () => {
    const copied = complete([paragraph([copyText('L '), { kind: 'link', url: '', title: 't', children: [copyText('l')] }])])
    expect(copied).toBe('L [l](<> "t")')
    const link = parse(copied).children?.[0]?.children?.[1]
    expect([link?.url, link?.title]).toEqual(['', 't'])
  })
  it('pairs literals across the cells of a Markdown-mode grid, but not a Markdown table', () => {
    const row = (...cells: CopyNode[][]): CopyNode => ({ kind: 'row', children: cells.map(children => ({ kind: 'cell', children })) })
    const table: CopyNode = { kind: 'table', align: [], children: [row([copyText('$a')], [strong('B')], [copyText('b$')])] }
    const selection: CopySelection = new Map()
    const cells = 'children' in table.children[0] ? table.children[0].children : []
    for (const cell of cells) if ('children' in cell) for (const node of cell.children) {
      const leaf = 'children' in node ? node.children[0] : node
      selection.set(leaf, { from: 0, to: 2 })
    }
    // A grid pastes as running lines, so dollars in different cells could pair as math.
    expect(serializeCopy([table], { mode: 'markdown', intent: 'selection', selection })).toBe('\\$a\t**B**\tb\\$')
    expect(complete([{ kind: 'table', align: [], children: [row([copyText('H')], [copyText('I')], [copyText('#')]),
      row([copyText('$a')], [strong('B')], [copyText('b$')])] }])).toBe('| H | I | # |\n| --- | --- | --- |\n| $a | **B** | b$ |')
  })
  it('keeps a literal exclamation mark from turning the link after it into an image', () => {
    const link: CopyNode = { kind: 'link', url: 'https://x.test', children: [copyText('docs')] }
    const copied = complete([paragraph([copyText('L !'), link, copyText(' R')])])
    expect(copied).toBe('L \\![docs](https://x.test) R')
    expect(types(parse(copied))).toContain('link')
    expect(types(parse(copied))).not.toContain('image')
    expect(complete([paragraph([copyText('L ! '), link])])).toBe('L ! [docs](https://x.test)')
  })
  it('keeps a bare URL from absorbing the syntax or escapes after it', () => {
    const code: CopyNode = { kind: 'code', value: 'c', block: false }
    const cases: [CopyNode[], string, string, string][] = [
      [[copyText('L https://example.org/'), strong('bold'), copyText(' R')], 'L https\\://example.org/**bold** R', 'strong',
        'L https://example.org/bold R'],
      [[copyText('L www.x.org/'), strong('b'), copyText(' R')], 'L www\\.x.org/**b** R', 'strong', 'L www.x.org/b R'],
      [[copyText('L HTTP://x.org/'), code, copyText(' R')], 'L HTTP\\://x.org/`c` R', 'inlineCode', 'L HTTP://x.org/c R'],
      [[copyText('L https://x.org'), { kind: 'break' }, copyText('next '), strong('B')], 'L https\\://x.org\\\nnext **B**', 'break',
        'L https://x.org\nnext B'],
      // An escape inside the URL would show as a backslash in the link text.
      [[copyText('L https://x.org/*a* '), strong('B')], 'L https\\://x.org/\\*a\\* **B**', 'strong', 'L https://x.org/*a* B'],
      // The `<` ends the URL, but the backslash inserted before it would not.
      [[copyText('L https://x.org/<user> '), strong('B'), copyText(' R')], 'L https\\://x.org/\\<user> **B** R', 'strong',
        'L https://x.org/<user> B R'],
      [[strong('B'), copyText(' https://x.org/*a*')], '**B** https\\://x.org/\\*a\\*', 'strong', 'B https://x.org/*a*']
    ]
    for (const [children, expected, type, shown] of cases) {
      const copied = complete([paragraph(children)])
      expect(copied).toBe(expected)
      expect(types(parse(copied))).toContain(type)
      expect(characters(parse(copied)).map(char => char.text).join('')).toBe(shown)
    }
  })
  it('leaves a bare URL alone where nothing it would absorb follows', () => {
    expect(complete([paragraph([strong('see https://x.org'), copyText(', R')])])).toBe('**see https://x.org**, R')
    expect(complete([paragraph([copyText('L https://x.org/a '), strong('B')])])).toBe('L https://x.org/a **B**')
    expect(complete([paragraph([copyText('L https://x.org/a<'), strong('b'), copyText(' R')])])).toBe('L https://x.org/a<**b** R')
    const link: CopyNode = { kind: 'link', url: 'https://x.org/', children: [copyText('https://x.org/'), strong('b')] }
    expect(complete([paragraph([copyText('L '), link])])).toBe('L [https://x.org/**b**](https://x.org/)')
  })
  it('treats a generated marker beside an escaped literal as able to pair', () => {
    // Once the literal beside it is escaped, the closing marker can close against a bare opener inside the span.
    const cases: [CopyNode, string, number][] = [
      [{ kind: 'em', children: [copyText('multiply a *b by c *')] }, 'L *multiply a \\*b by c \\** R', 1],
      [strong('Pass *args to fields marked *'), 'L **Pass \\*args to fields marked \\*** R', 2],
      [{ kind: 'strike', children: [copyText('c ~~b d ~')] }, 'L ~~c \\~\\~b d \\~~~ R', 4],
      // Strikethrough pairs equal runs, so the generated opener counts apart from the literal beside it.
      [{ kind: 'strike', children: [copyText('~a~~ b')] }, 'L ~~\\~a\\~\\~ b~~ R', 4]
    ]
    for (const [node, copied, style] of cases) {
      expect(complete([paragraph([copyText('L '), node, copyText(' R')])])).toBe(copied)
      const body = 'children' in node && 'value' in node.children[0] ? node.children[0].value : ''
      expect(characters(parseStrict(copied)).filter(char => /\S/.test(char.text))).toEqual([{ text: 'L', styles: 0 },
        ...Array.from(body.replace(/\s/g, ''), text => ({ text, styles: style })), { text: 'R', styles: 0 }])
    }
  })
  it('counts a tilde as a marker character beside an emphasis run', () => {
    // Strikethrough registers the tilde as an attention marker, so the first asterisk can open before it.
    const copied = complete([paragraph([copyText('L x*~a* '), { kind: 'strike', children: [copyText('B')] }, copyText(' R')])])
    expect(copied).toBe('L x\\*~a\\* ~~B~~ R')
    expect(types(parseStrict(copied))).not.toContain('emphasis')
  })

  const gridCopy = (rows: CopyNode[][][]): string => {
    const table: CopyNode = { kind: 'table', align: [], children: rows.map(cells =>
      ({ kind: 'row', children: cells.map(children => ({ kind: 'cell', children })) })) }
    const selection: CopySelection = new Map()
    const select = (node: CopyNode): void => {
      if ('children' in node) node.children.forEach(select)
      else selection.set(node, { from: 0, to: 'value' in node ? node.value.length : 0 })
    }
    select(table)
    return serializeCopy([table], { mode: 'markdown', intent: 'selection', selection })
  }
  it('treats the quotes around a grid field as punctuation beside its delimiters', () => {
    const copied = gridCopy([[[copyText('*x "y"')], [copyText('* "z"')], [strong('B')]]])
    expect(copied).toBe('"\\*x ""y"""\t"\\* ""z"""\t**B**')
    expect(types(parseStrict(copied))).not.toContain('emphasis')
    // A lone field is never quoted, so its first character starts the line.
    expect(gridCopy([[[copyText('- "a" '), strong('B')]]])).toBe('\\- "a" **B**')
  })
  it('checks block syntax on whole grid rows, across cells and blank rows', () => {
    const underscores = gridCopy([[[strong('B')], [copyText('A')], [copyText('C')]], [[copyText('_')], [copyText('_')], [copyText('_')]]])
    expect(underscores).toBe('**B**\tA\tC\n\\_\t_\t_')
    expect(types(parseStrict(underscores))).not.toContain('thematicBreak')
    const dashes = gridCopy([[[strong('B')], [copyText('A')]], [[copyText('-')], [copyText('-')]]])
    expect(dashes).toBe('**B**\tA\n\\-\t-')
    expect(types(parseStrict(dashes))).not.toContain('heading')
    const blank = gridCopy([[[strong('B')]], [[copyText('')]], [[copyText('2. item')]]])
    expect(blank).toBe('**B**\n\n2\\. item')
    expect(types(parseStrict(blank))).not.toContain('list')
    // A passage that begins with a line break pastes its second line as the first.
    expect(leading('\n5. a ')).toBe('\n5\\. a **B**')
  })
  it('escapes block syntax at the start of a grid row, but not after a tab', () => {
    const copied = gridCopy([[[strong('B')], [copyText('- a')]], [[copyText('- b')], [copyText('# c')]]])
    expect(copied).toBe('**B**\t- a\n\\- b\t# c')
    expect(types(parseStrict(copied))).not.toContain('list')
  })
  // Generous ceilings, far above a linear pass and well below the quadratic one.
  it('escapes a large grid in one pass, not one per cell', () => {
    const rows = Array.from({ length: 400 }, (_, r) =>
      Array.from({ length: 10 }, (_, c) => c ? [copyText(`cell ${r} a_b <c ~/p $${c}`)] : [strong(`B${r}`)]))
    const started = performance.now()
    expect(gridCopy(rows).split('\n')).toHaveLength(400)
    expect(performance.now() - started).toBeLessThan(300)
  })
  it('finds the extent of a long run of angle brackets once', () => {
    const text = '<='.repeat(100_000) + ' >'
    const started = performance.now()
    expect(complete([paragraph([copyText(text), strong('B')])])).toBe(text + '**B**')
    expect(performance.now() - started).toBeLessThan(150)
    const urls = 'https://'.repeat(50_000)
    const urlStarted = performance.now()
    expect(complete([paragraph([copyText(urls + ' '), strong('B')])])).toBe(urls + ' **B**')
    expect(performance.now() - urlStarted).toBeLessThan(150)
    // A closing bracket in a later chunk does not close a run that ends before it.
    expect(complete([paragraph([copyText('if a <= b '), strong('B'), copyText(' c > d')])])).toBe('if a <= b **B** c > d')
  })
})

describe('literal escaping fuzz', () => {
  // A seeded generator keeps failures reproducible while covering every ASCII punctuation mark.
  function random(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
  const alphabet = [...punctuation, ...punctuation, 'a', 'b', 'é', '1', ' ', ' ', '\n']
  const fuzz = (next: () => number, inline: boolean): string => {
    let text = ''
    for (let length = 1 + Math.floor(next() * 12); length > 0; length--) text += alphabet[Math.floor(next() * alphabet.length)]
    // Paragraph splits and line-only contexts are structure, not literal content.
    return inline ? text.replace(/\n/g, ' ') : text.replace(/\n\s*\n/g, '\n')
  }
  const em = (text: string): CopyNode => ({ kind: 'em', children: [copyText(text)] })
  const contexts: [string, boolean, (text: string) => CopyNode[]][] = [
    ['tight paragraph', false, text => [paragraph([em('a'), copyText(text), { kind: 'strong', children: [copyText('b')] }])]],
    ['inside bold', false, text => [paragraph([copyText('L '), { kind: 'strong', children: [copyText('a' + text + 'b')] },
      copyText(' R '), em('c')])]],
    ['inside italic', false, text => [paragraph([{ kind: 'em', children: [copyText(text + 'a')] }, copyText(text)])]],
    ['spaced paragraph', false, text => [paragraph([copyText(text + ' '), em('a'), copyText(' ' + text)])]],
    ['strike neighbor', false, text => [paragraph([{ kind: 'strike', children: [copyText('s')] }, copyText(text)])]],
    ['math and code', false, text => [paragraph([{ kind: 'math', value: 'm', display: false }, copyText(text),
      { kind: 'code', value: 'c$~d', block: false }])]],
    ['list item', false, text => [{ kind: 'list', start: null, children: [{ kind: 'item', children: [copyText(text)] },
      { kind: 'item', children: [copyText('z')] }] }]],
    ['quote', false, text => [{ kind: 'quote', children: [paragraph([copyText(text), em('a')])] }]],
    ['heading', true, text => [{ kind: 'heading', level: 2, children: [em('a'), copyText(text)] }]],
    ['leading heading', true, text => [{ kind: 'heading', level: 2, children: [copyText(text), em('a')] }]],
    ['link label', true, text => [paragraph([copyText('L '), { kind: 'link', url: 'https://x.test', children: [copyText(text)] }])]],
    ['table cell', true, text => [{ kind: 'table', align: [], children: [
      { kind: 'row', children: [{ kind: 'cell', children: [copyText('H')] }, { kind: 'cell', children: [copyText('I')] }] },
      { kind: 'row', children: [{ kind: 'cell', children: [copyText(text)] }, { kind: 'cell', children: [em('a')] }] }] }]]
  ]
  function expected(nodes: CopyNode[], styles = 0): { text: string; styles: number }[] {
    return nodes.flatMap(node => {
      const inherited = styles | (node.kind === 'em' ? 1 : node.kind === 'strong' ? 2 : node.kind === 'strike' ? 4 : 0)
      // The strict parser reads an inline formula's delimiters as text.
      const value = node.kind === 'math' ? '$' + node.value + '$' : 'value' in node ? node.value : ''
      if (node.kind === 'text' || node.kind === 'code' || node.kind === 'math') return Array.from(value, text => ({ text, styles: inherited }))
      return 'children' in node ? expected(node.children, inherited) : []
    })
  }
  // Whitespace placement is the serializer's documented normalization; escaping protects everything else.
  const visible = (chars: { text: string; styles: number }[]) => chars.filter(char => /\S/.test(char.text))
  const spacing = (chars: { text: string }[]) => chars.map(char => char.text).join('').replace(/\s+/g, ' ').trim()
  // GFM autolink literals form whatever the escaping, so their link wrapper is not a regression.
  function skeleton(node: ParsedNode): string[] {
    const text = characters(node).map(char => char.text).join('')
    const literal = node.type === 'link' && [text, 'mailto:' + text, 'http://' + text].includes(node.url ?? '')
    return [...(literal || ['text', 'break'].includes(node.type) ? [] : [node.type]), ...(node.children ?? []).flatMap(skeleton)]
  }

  it.each(contexts)('round-trips random punctuation in a %s', (label, inline, build) => {
    const next = random(0x5eed)
    // The oracle joins sibling blocks without a separator, and cells trim their padding.
    const spaced = !['list item', 'table cell'].includes(label)
    const shape = skeleton(parseStrict(complete(build('z'))))
    for (let index = 0; index < 1500; index++) {
      const text = fuzz(next, inline), nodes = build(text)
      // An item or cell holding only whitespace is empty structure, which escaping cannot affect.
      if (!/\S/.test(text)) continue
      const copied = complete(nodes), parsed = parseStrict(copied)
      const message = JSON.stringify(text) + ' -> ' + JSON.stringify(copied)
      expect(skeleton(parsed), message).toEqual(shape)
      expect(visible(characters(parsed)), message).toEqual(visible(expected(nodes)))
      if (spaced) expect(spacing(characters(parsed)), message).toBe(spacing(expected(nodes)))
    }
  })
  // Several literal slots, so a bare delimiter in one can pair with generated syntax beside another.
  it('round-trips random punctuation across several styled and literal slots', () => {
    const next = random(0xc0de)
    const slot = (text: string, previous?: CopyNode): CopyNode => {
      const kinds = ['text', 'em', 'strong', 'strike', 'code', 'link'] as const
      const kind = kinds[Math.floor(next() * kinds.length)]
      if (kind === 'text') return copyText(text)
      // Source cannot place two code spans against each other.
      if (kind === 'code') return previous?.kind === 'code' ? copyText(text) : { kind: 'code', value: 'c', block: false }
      if (kind === 'link') return { kind: 'link', url: 'https://x.test', children: [copyText(text)] }
      // A styled body that is only whitespace drops its markers, so give it a visible character.
      return { kind, children: [copyText(/\S/.test(text) ? text : 'q')] }
    }
    const blank = (node: CopyNode): CopyNode => node.kind === 'text' ? copyText('z')
      : 'children' in node ? { ...node, children: node.children.map(blank) } as CopyNode : node
    // Weighted toward delimiters, so a bare one often shares a span with a literal beside generated syntax.
    const delimiters = [...alphabet, ...'*_~*_~*_~*_~*_~*_~ ']
    const text = (): string => Array.from({ length: 1 + Math.floor(next() * 8) },
      () => delimiters[Math.floor(next() * delimiters.length)]).join('').replace(/\n/g, ' ')
    for (let index = 0; index < 3000; index++) {
      const children: CopyNode[] = []
      for (let count = 2 + Math.floor(next() * 5); count > 0; count--) children.push(slot(text(), children[children.length - 1]))
      const nodes = [paragraph(children)]
      // A passage without markup is copied as written.
      if (children.every(child => child.kind === 'text') || !/\S/.test(expected(nodes).map(char => char.text).join(''))) continue
      const copied = complete(nodes), parsed = parseStrict(copied)
      const message = JSON.stringify(nodes) + ' -> ' + JSON.stringify(copied)
      expect(skeleton(parsed), message).toEqual(skeleton(parseStrict(complete(nodes.map(blank)))))
      expect(visible(characters(parsed)), message).toEqual(visible(expected(nodes)))
    }
  })
})
