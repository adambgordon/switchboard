import { describe, expect, it } from 'vitest'
import { assembleCopy, copyText, fence, rowsToText, serializeCopy, type CopyNode, type CopySelection, type CopyMode } from '../src/renderer/lib/mdCopy'

const inline = (children: CopyNode[]): CopyNode => ({ kind: 'paragraph', children })
function selected(nodes: CopyNode[], from: number, to: number): CopySelection {
  const selection: CopySelection = new Map()
  let position = 0
  const visit = (node: CopyNode): void => {
    if ('children' in node) { node.children.forEach(visit); return }
    const length = 'value' in node ? node.value.length : node.kind === 'break' ? 1 : 0
    const start = Math.max(0, from - position)
    const end = Math.min(length, to - position)
    if (end > start) selection.set(node, { from: start, to: end })
    position += length
  }
  nodes.forEach(visit)
  return selection
}
function copy(nodes: CopyNode[], from: number, to: number, mode: CopyMode = 'markdown'): string {
  return serializeCopy(nodes, { mode, intent: 'selection', selection: selected(nodes, from, to) })
}
const complete = (nodes: CopyNode[], mode: CopyMode = 'markdown'): string =>
  serializeCopy(nodes, { mode, intent: 'complete' })

const wrappers: [string, () => CopyNode, string][] = [
  ['bold', () => ({ kind: 'strong', children: [copyText('abc')] }), '**abc**'],
  ['italic', () => ({ kind: 'em', children: [copyText('abc')] }), '*abc*'],
  ['strike', () => ({ kind: 'strike', children: [copyText('abc')] }), '~~abc~~'],
  ['code', () => ({ kind: 'code', value: 'abc', block: false }), '`abc`'],
  ['link', () => ({ kind: 'link', url: 'https://example.org/abc', children: [copyText('abc')] }), '[abc](<https://example.org/abc>)']
]
describe.each(wrappers)('%s selection boundaries', (_name, wrapper, marked) => {
  const document = (): CopyNode[] => [inline([copyText('L '), wrapper(), copyText(' R')])]
  it('omits outer syntax for an exact selection', () => expect(copy(document(), 2, 5)).toBe('abc'))
  it('retains syntax when extending past only the left edge', () => expect(copy(document(), 0, 5)).toBe(`L ${marked}`))
  it('retains syntax when extending past only the right edge', () => expect(copy(document(), 2, 7)).toBe(`${marked} R`))
  it('does not count whitespace alone on either side', () => expect(copy(document(), 1, 6)).toBe(' abc '))
  it('accepts right context when only whitespace is selected on the left', () => expect(copy(document(), 1, 7)).toBe(` ${marked} R`))
  it('accepts left context when only whitespace is selected on the right', () => expect(copy(document(), 0, 6)).toBe(`L ${marked} `))
  it('retains syntax with selected content on both sides', () => expect(copy(document(), 0, 7)).toBe(`L ${marked} R`))
  it('does not leave markers on a partial crossing', () => {
    expect(copy(document(), 3, 7)).toBe('bc R')
    expect(copy(document(), 0, 4)).toBe('L ab')
  })
  it('never adds styling in plain mode', () => expect(copy(document(), 0, 7, 'plain')).toBe('L abc R'))
})

describe('nested and block selections', () => {
  it('evaluates layers independently', () => {
    const nodes: CopyNode[] = [{ kind: 'strong', children: [copyText('alpha '), { kind: 'em', children: [copyText('beta')] }, copyText(' gamma')] }]
    expect(copy(nodes, 0, 16)).toBe('alpha *beta* gamma')
  })
  it('does not let code-only wrappers reintroduce syntax', () => {
    const code: CopyNode = { kind: 'code', value: 'run', block: false }
    for (const node of [inline([code]), { kind: 'heading', level: 2, children: [code] } as CopyNode,
      { kind: 'strong', children: [code] } as CopyNode]) expect(copy([node], 0, 3)).toBe('run')
  })
  it('handles headings and quotes with the same boundary rule', () => {
    for (const node of [{ kind: 'heading', level: 2, children: [copyText('abc')] },
      { kind: 'quote', children: [inline([copyText('abc')])] }] as CopyNode[]) {
      expect(copy([copyText('L'), node, copyText('R')], 1, 4)).toBe('abc')
      expect(copy([copyText('L'), node], 0, 4)).toBe(node.kind === 'heading' ? 'L\n\n## abc' : 'L\n\n> abc')
      expect(copy([node, copyText('R')], 0, 4)).toBe(node.kind === 'heading' ? '## abc\n\nR' : '> abc\n\nR')
      expect(copy([copyText('L'), node, copyText('R')], 0, 5)).toBe(node.kind === 'heading' ? 'L\n\n## abc\n\nR' : 'L\n\n> abc\n\nR')
    }
  })
  it('never half-fences partial code crossed from either direction', () => {
    const nodes: CopyNode[] = [copyText('L'), { kind: 'code', value: 'abc', block: true, lang: 'sh' }, copyText('R')]
    expect(copy(nodes, 0, 3)).toBe('L\n\nab')
    expect(copy(nodes, 2, 5)).toBe('bc\n\nR')
    expect(copy(nodes, 0, 4)).toBe('L\n\n```sh\nabc\n```')
    expect(copy(nodes, 1, 5)).toBe('```sh\nabc\n```\n\nR')
    expect(copy(nodes, 0, 5)).toBe('L\n\n```sh\nabc\n```\n\nR')
  })
  it('preserves indentation, trailing whitespace and whitespace-only selections', () => {
    const nodes: CopyNode[] = [{ kind: 'code', value: '  a\n\tb  \n', block: true }]
    expect(copy(nodes, 0, 9)).toBe('  a\n\tb  \n')
    expect(copy([copyText('  a  ')], 0, 2)).toBe('  ')
    expect(copy([copyText('  a  ')], 0, 5)).toBe('  a  ')
  })
  it('leaves bare punctuation literal', () => expect(copy([copyText('**`&')], 0, 4)).toBe('**`&'))
})

describe('list structure', () => {
  const list = (): CopyNode => ({ kind: 'list', start: 3, children: [
    { kind: 'item', checked: true, children: [copyText('one')] },
    { kind: 'item', checked: false, children: [copyText('two')] }
  ] })
  it('keeps complete items in multi-item selections in both modes', () => {
    expect(copy([list()], 0, 6)).toBe('3. [x] one\n4. [ ] two')
    expect(copy([list()], 0, 6, 'plain')).toBe('3. [x] one\n4. [ ] two')
  })
  it('omits markers on an isolated exact item and partial siblings', () => {
    expect(copy([list()], 0, 3)).toBe('one')
    expect(copy([list()], 1, 6)).toBe('ne\n4. [ ] two')
    expect(copy([list()], 0, 5)).toBe('3. [x] one\ntw')
  })
  it('uses list-marker indentation, excluding checkbox text, for nested lists', () => {
    const node: CopyNode = { kind: 'list', start: null, children: [
      { kind: 'item', checked: true, children: [copyText('outer'), { kind: 'list', start: null, children: [
        { kind: 'item', children: [copyText('child')] }
      ] }] },
      { kind: 'item', children: [copyText('end')] }
    ] }
    expect(copy([node], 0, 13)).toBe('- [x] outer\n  - child\n- end')
  })
  it('does not count unselected or whitespace-only sibling content', () => {
    const node: CopyNode = { kind: 'list', start: null, children: [
      { kind: 'item', children: [copyText('one')] }, { kind: 'item', children: [copyText('  two')] }
    ] }
    expect(copy([node], 0, 5)).toBe('one\n  ')
  })
})

describe('literal punctuation in list copies', () => {
  const literal = 'a*b*c _d_ `e` [f](g) \\h'
  const escaped = 'a\\*b\\*c \\_d\\_ \\`e\\` \\[f\\]\\(g\\) \\\\h'
  const list = (start: number | null, checked?: boolean): CopyNode => ({ kind: 'list', start, children: [
    { kind: 'item', checked, children: [copyText(literal)] },
    { kind: 'item', checked, children: [copyText('second')] }
  ] })
  it.each([
    ['unordered', null, undefined, '- ', '- '],
    ['ordered', 3, undefined, '3. ', '4. '],
    ['task', null, true, '- [x] ', '- [x] ']
  ] as const)('escapes retained %s items only in Markdown', (_label, start, checked, first, second) => {
    const nodes = [list(start, checked)]
    expect(copy(nodes, 0, literal.length + 6)).toBe(first + escaped + '\n' + second + 'second')
    expect(copy(nodes, 0, literal.length + 6, 'plain')).toBe(first + literal + '\n' + second + 'second')
    expect(complete(nodes)).toBe(first + escaped + '\n' + second + 'second')
  })
  it.each(['markdown', 'plain'] as const)('leaves isolated and partial items literal in %s', mode => {
    const nodes = [list(null)]
    expect(copy(nodes, 0, literal.length, mode)).toBe(literal)
    expect(copy(nodes, 1, literal.length, mode)).toBe(literal.slice(1))
    expect(copy(nodes, 1, literal.length + 6, mode)).toBe(literal.slice(1) + '\n- second')
  })
  it('escapes nested list bodies inside a retained quote', () => {
    const nested: CopyNode = { kind: 'list', start: null, children: [
      { kind: 'item', children: [copyText('outer'), list(null)] }
    ] }
    const nodes: CopyNode[] = [copyText('L'), { kind: 'quote', children: [nested] }, copyText('R')]
    expect(complete(nodes)).toBe('L\n\n> - outer\n>   - ' + escaped + '\n>   - second\n\nR')
    expect(complete(nodes, 'plain')).toBe('L\n\n- outer\n  - ' + literal + '\n  - second\n\nR')
  })
})

describe.each(['markdown', 'plain'] as const)('thematic breaks in %s copies', mode => {
  const rule: CopyNode = { kind: 'rule' }
  const nodes = [copyText('Before'), rule, copyText('After')]
  function withRule(from: number, to: number): string {
    const selection = selected(nodes, from, to)
    // A divider has no text offsets; its DOM range coverage supplies this entry.
    selection.set(rule, { from: 0, to: 0 })
    return serializeCopy(nodes, { mode, intent: 'selection', selection })
  }
  it('retains a divider with context on both sides', () => expect(withRule(0, 11)).toBe('Before\n\n---\n\nAfter'))
  it('retains a divider with only left context', () => expect(withRule(0, 6)).toBe('Before\n\n---'))
  it('retains a divider with only right context', () => expect(withRule(6, 11)).toBe('---\n\nAfter'))
  it('omits an isolated selected divider', () => expect(withRule(6, 6)).toBe(''))
  it('does not invent coverage of an unselected divider', () => expect(copy(nodes, 0, 6, mode)).toBe('Before'))
  it('retains a divider for a complete-content action', () => expect(complete([rule], mode)).toBe('---'))
})

describe('tables own their syntax', () => {
  const table = (): CopyNode => ({ kind: 'table', align: ['left', null, 'right'], children: [
    { kind: 'row', children: ['A', 'B', 'C'].map(value => ({ kind: 'cell', children: [{ kind: 'strong', children: [copyText(value)] }] })) }
  ] })
  it('keeps eligible nested formatting in an exact tab-separated selection', () => {
    expect(copy([table()], 0, 3)).toBe('**A**\t**B**\t**C**')
    expect(copy([table()], 1, 2)).toBe('B')
    expect(copy([table()], 0, 3, 'plain')).toBe('A\tB\tC')
  })
  it('emits pipes for a contextual table or complete-content action', () => {
    expect(copy([copyText('L'), table(), copyText('R')], 0, 5)).toBe('L\n\n| **A** | **B** | **C** |\n| :--- | --- | ---: |\n\nR')
    expect(copy([copyText('L'), table()], 0, 4)).toBe('L\n\n| **A** | **B** | **C** |\n| :--- | --- | ---: |')
    expect(copy([table(), copyText('R')], 0, 4)).toBe('| **A** | **B** | **C** |\n| :--- | --- | ---: |\n\nR')
    expect(complete([table()])).toBe('| **A** | **B** | **C** |\n| :--- | --- | ---: |')
  })
  it('preserves partial cells and ragged rows without padding', () => {
    const node: CopyNode = { kind: 'table', align: [], children: [
      { kind: 'row', children: [{ kind: 'cell', children: [copyText('alpha')] }, { kind: 'cell', children: [copyText('bravo')] }] },
      { kind: 'row', children: [{ kind: 'cell', children: [copyText('charlie')] }, { kind: 'cell', children: [copyText('delta')] }] }
    ] }
    expect(copy([node], 2, 13)).toBe('pha\tbravo\ncha')
  })
  it('quotes embedded separators and quotes only for multiple cells', () => {
    expect(rowsToText([['a\tb', 'c\nd', 'say "hi"']])).toBe('"a\tb"\t"c\nd"\t"say ""hi"""')
    expect(rowsToText([['a\tb\n"c"']])).toBe('a\tb\n"c"')
    expect(rowsToText([['', 'x', '']])).toBe('\tx\t')
  })
})

describe('attribution and special content', () => {
  it('uses global selected content, excluding generated speaker labels', () => {
    const sections = [{ label: 'You', isSidechain: false, nodes: [copyText('L')] },
      { label: 'Codex', isSidechain: false, nodes: [{ kind: 'strong', children: [copyText('abc')] } as CopyNode] },
      { label: 'You', isSidechain: false, nodes: [copyText('R')] }]
    const nodes = sections.flatMap(s => s.nodes)
    expect(assembleCopy(sections, { mode: 'markdown', intent: 'selection', selection: selected(nodes, 0, 5) })).toBe('**You:**\n\nL\n\n---\n\n**Codex:**\n\n**abc**\n\n---\n\n**You:**\n\nR')
    expect(assembleCopy(sections, { mode: 'markdown', intent: 'selection', selection: selected(nodes, 1, 4) })).toBe('abc')
  })
  it('applies context to math and tool framing in both modes', () => {
    const tool: CopyNode = { kind: 'tool', label: 'Result', value: 'abc' }
    expect(copy([tool], 0, 3)).toBe('abc')
    expect(copy([copyText('L'), tool, copyText('R')], 0, 5)).toBe('L\n\nResult:\n\n```\nabc\n```\n\nR')
    expect(copy([copyText('L'), tool, copyText('R')], 0, 5, 'plain')).toBe('L\n\nResult:\n\nabc\n\nR')
    const math: CopyNode = { kind: 'math', value: 'x', display: false }
    expect(copy([math], 0, 1)).toBe('x')
    expect(copy([copyText('L'), math, copyText('R')], 0, 3)).toBe('L\n\n$x$\n\nR')
  })
  it('handles many backtick runs without spreading them into function arguments', () => {
    const body = 'a`'.repeat(150000)
    expect(fence(body)).toBe('```\n' + body + '\n```')
  })
  it('keeps code payload newlines when generating fences', () => {
    expect(fence('  a\n')).toBe('```\n  a\n\n```')
    expect(fence('```', 'text')).toBe('````text\n```\n````')
  })
})

describe('inline serialization and table coverage', () => {
  it.each(['strong', 'em', 'strike'] as const)('coalesces adjacent retained %s spans after eligibility', kind => {
    const nodes: CopyNode[] = [inline([
      { kind, children: [copyText('aa')] }, { kind, children: [copyText('bb')] }
    ])]
    const marker = kind === 'strong' ? '**' : kind === 'em' ? '*' : '~~'
    expect(copy(nodes, 0, 4)).toBe(marker + 'aabb' + marker)
    expect(copy(nodes, 0, 2)).toBe('aa')
    expect(copy(nodes, 1, 3)).toBe('ab')
    expect(copy(nodes, 1, 4)).toBe('a' + marker + 'bb' + marker)
  })
  it('normalizes nested spans after their outer spans combine', () => {
    const nodes: CopyNode[] = [inline(['a', 'b'].map(value => ({ kind: 'strong', children: [
      { kind: 'em', children: [copyText(value)] }
    ] })))]
    expect(copy(nodes, 0, 2)).toBe('***ab***')
  })
  it('keeps selected spaces between retained runs', () => {
    const nodes: CopyNode[] = [inline([
      { kind: 'strong', children: [copyText('a')] }, copyText(' '), { kind: 'strong', children: [copyText('b')] }
    ])]
    expect(copy(nodes, 0, 3)).toBe('**a** **b**')
    expect(copy(nodes, 1, 2)).toBe(' ')
  })
  it('requires coverage of an empty boundary cell before emitting table syntax', () => {
    const empty: CopyNode = { kind: 'cell', children: [] }
    const table: CopyNode = { kind: 'table', align: [], children: [
      { kind: 'row', children: [empty, { kind: 'cell', children: [copyText('B')] }] },
      { kind: 'row', children: [{ kind: 'cell', children: [copyText('C')] }, { kind: 'cell', children: [copyText('D')] }] }
    ] }
    const nodes = [table, copyText('After')]
    expect(copy(nodes, 0, 8)).toBe('B\nC\tD\n\nAfter')
    const selection = selected(nodes, 0, 8)
    selection.set(empty, { from: 0, to: 0 })
    expect(serializeCopy(nodes, { mode: 'markdown', intent: 'selection', selection })).toBe('|  | B |\n| --- | --- |\n| C | D |\n\nAfter')
    expect(complete([table])).toBe('|  | B |\n| --- | --- |\n| C | D |')
  })
})
