import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { copyText, serializeCopy, type CopyNode } from '../src/renderer/lib/mdCopy'
import { markdownCopyNodes } from '../src/renderer/lib/mdCopyAst'

interface ParsedNode { type: string; value?: string; url?: string; title?: string | null; children?: ParsedNode[] }
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const parse = (source: string): ParsedNode => parser.parse(source) as ParsedNode
const complete = (nodes: CopyNode[], mode: 'markdown' | 'plain' = 'markdown'): string =>
  serializeCopy(nodes, { mode, intent: 'complete' })
function characters(node: ParsedNode, styles = 0): { text: string; styles: number }[] {
  const inherited = styles | (node.type === 'emphasis' ? 1 : node.type === 'strong' ? 2 : node.type === 'delete' ? 4 : 0)
  if (node.type === 'text') return Array.from(node.value ?? '', text => ({ text, styles: inherited }))
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
