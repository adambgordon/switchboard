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
    expect(complete(markdownCopyNodes('x*a*__.__ R'))).toBe('&#120;*&#97;***\\.** R')
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
  it('escapes literal text consistently only in a mixed passage', () => {
    const source = 'Before (v2.1): **bold** after!'
    expect(complete(markdownCopyNodes(source))).toBe('Before \\(v2\\.1\\)\\: **bold** after\\!')
    expect(complete(markdownCopyNodes(source), 'plain')).toBe('Before (v2.1): bold after!')
    const literal = copyText('*literal* (v2.1)')
    expect(serializeCopy([paragraph([literal])], { mode: 'markdown', intent: 'selection',
      selection: new Map([[literal, { from: 0, to: 16 }]]) })).toBe('*literal* (v2.1)')
  })
  it('protects literal markers in neighbouring TSV cells', () => {
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
