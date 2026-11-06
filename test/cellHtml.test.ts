import { describe, expect, it } from 'vitest'
import { parseCellHtml, type CellPart } from '../src/renderer/lib/cellHtml'

/** A cell's inline nodes: a string starting with `<` is inline HTML, any other string is text, and `{ el }` is an
 *  element such as the strong or code span the parser leaves beside the HTML. */
type Node = string | { el: string }
const reader = {
  html: (node: Node): string | null => typeof node === 'string' && node.startsWith('<') ? node : null,
  text: (node: Node): string | null => typeof node === 'string' && !node.startsWith('<') ? node : null
}

/** Flattens the parsed structure so one assertion covers its whole shape. */
function show(parts: CellPart<Node>[] | null): string | null {
  if (parts === null) return null
  return parts.map(part => {
    if (part.kind === 'break') return 'BR'
    if (part.kind === 'list') {
      return `${part.ordered ? 'OL' : 'UL'}[${part.items.map(item => `LI(${show(item)})`).join(' ')}]`
    }
    return typeof part.node === 'string' ? JSON.stringify(part.node) : part.node.el
  }).join(' ')
}
const parse = (...nodes: Node[]): string | null => show(parseCellHtml(nodes, reader))

describe('parseCellHtml', () => {
  it('leaves a cell without any recognized tag alone', () => {
    expect(parse('plain ', { el: 'strong' }, ' text')).toBeNull()
    expect(parse('a ', '<b>', 'bold', '</b>', ' <c>')).toBeNull()
  })

  it('reads every spelling of a line break', () => {
    expect(parse('a', '<br>', 'b', '<br/>', 'c', '<br />', 'd', '<BR />', 'e')).toBe(
      '"a" BR "b" BR "c" BR "d" BR "e"'
    )
  })

  it('reads a list in place, keeping the nodes around it and inside its items', () => {
    expect(parse({ el: 'strong' }, ' ', '<ul>', '<li>', 'one', '</li>', '<li>', 'two ', { el: 'code' }, '</li>', '</ul>', ' tail'))
      .toBe('strong " " UL[LI("one") LI("two " code)] " tail"')
  })

  it('tells ordered lists from unordered ones', () => {
    expect(parse('<ol>', '<li>', 'a', '</li>', '</ol>', '<UL>', '<LI>', 'b', '</LI>', '</UL>')).toBe(
      'OL[LI("a")] UL[LI("b")]'
    )
  })

  it('reads nested lists and breaks inside items', () => {
    expect(parse('<ul>', '<li>', 'a', '<br>', 'b', '<ol>', '<li>', 'c', '</li>', '</ol>', '</li>', '</ul>')).toBe(
      'UL[LI("a" BR "b" OL[LI("c")])]'
    )
  })

  it('drops layout whitespace between items', () => {
    expect(parse('<ul>', '\n  ', '<li>', 'a', '</li>', ' ', '<li>', 'b', '</li>', '\n', '</ul>')).toBe('UL[LI("a") LI("b")]')
  })

  it('keeps a tag with attributes literal while still reading the plain tags beside it', () => {
    expect(parse('<ul class="x">', 'a', '<br>', 'b')).toBe('"<ul class=\\"x\\">" "a" BR "b"')
  })

  it.each([
    ['a closer that does not match its list', ['<ul>', '<li>', 'a', '</li>', '</ol>']],
    ['text between items', ['<ul>', '<li>', 'a', '</li>', ' stray ', '<li>', 'b', '</li>', '</ul>']],
    ['text after the last item', ['<ul>', '<li>', 'a', '</li>', ' stray', '</ul>']],
    ['an element between items', ['<ul>', { el: 'strong' }, '<li>', 'a', '</li>', '</ul>']],
    ['another tag between items', ['<ul>', '<b>', '<li>', 'a', '</li>', '</ul>']],
    ['a break between items', ['<ul>', '<li>', 'a', '</li>', '<br>', '</ul>']],
    ['a list directly inside a list', ['<ul>', '<ul>', '<li>', 'a', '</li>', '</ul>', '</ul>']],
    ['an item left open', ['<ul>', '<li>', 'a', '</ul>']],
    ['a list left open', ['<ul>', '<li>', 'a', '</li>']],
    ['an item outside a list', ['<li>', 'a', '</li>']],
    // Content after each stray closer, and a closer after each self-closing opener, so only the guard under test
    // can reject the cell.
    ['a stray item closer', ['a', '</li>', 'b']],
    ['a stray list closer', ['a', '</ul>', 'b']],
    ['a closing break', ['a', '</br>', 'b']],
    ['a self-closing list', ['<ul/>', '<li>', 'a', '</li>', '</ul>']],
    ['a self-closing item', ['<ul>', '<li/>', 'a', '</li>', '</ul>']]
  ] as [string, Node[]][])('leaves the whole cell literal for %s', (_, nodes) => {
    expect(parse(...nodes)).toBeNull()
  })
})
