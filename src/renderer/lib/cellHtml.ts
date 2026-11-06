/**
 * GFM table cells hold inline content only, so agents write line breaks and lists in them as inline HTML. The
 * Markdown parser hands each tag over as its own node beside the cell's other inline nodes. This recognizes the
 * exact tags `<br>`, `<ul>`, `<ol>` and `<li>` (no attributes, any case) and returns the cell's structure, or null
 * when the cell holds none of them or uses them in any shape other than a well-formed list. Null leaves the cell as
 * written, so every other tag, and every malformed use of these, stays literal text.
 *
 * Generic over the node type so the renderer (hast) and the copy adapter (mdast) read cells the same way.
 */
export type CellPart<N> =
  | { kind: 'node'; node: N }
  | { kind: 'break' }
  | { kind: 'list'; ordered: boolean; items: CellPart<N>[][] }

export interface CellReader<N> {
  /** The raw markup of an inline HTML node, or null for any other node. */
  html(node: N): string | null
  /** The value of a text node, or null for any other node. */
  text(node: N): string | null
}

const TAG = /^<(\/?)(br|ul|ol|li)[ \t]*(\/?)>$/i

type Frame<N> =
  | { kind: 'flow'; parts: CellPart<N>[]; item: boolean }
  | { kind: 'list'; list: CellPart<N> & { kind: 'list' } }

export function parseCellHtml<N>(children: readonly N[], reader: CellReader<N>): CellPart<N>[] | null {
  const root: CellPart<N>[] = []
  const stack: Frame<N>[] = [{ kind: 'flow', parts: root, item: false }]
  let found = false
  for (const node of children) {
    const top = stack[stack.length - 1]
    const html = reader.html(node)
    const tag = html === null ? null : TAG.exec(html)
    if (!tag) {
      if (top.kind === 'flow') {
        top.parts.push({ kind: 'node', node })
        continue
      }
      // Between items only layout whitespace may appear.
      const text = reader.text(node)
      if (text === null || /\S/.test(text)) return null
      continue
    }
    found = true
    const closing = tag[1] === '/', name = tag[2].toLowerCase(), selfClosing = tag[3] === '/'
    if (name === 'br') {
      if (closing || top.kind !== 'flow') return null
      top.parts.push({ kind: 'break' })
      continue
    }
    if (selfClosing) return null
    if (name === 'li') {
      if (!closing) {
        if (top.kind !== 'list') return null
        const parts: CellPart<N>[] = []
        top.list.items.push(parts)
        stack.push({ kind: 'flow', parts, item: true })
      } else {
        if (top.kind !== 'flow' || !top.item) return null
        stack.pop()
      }
      continue
    }
    const ordered = name === 'ol'
    if (!closing) {
      if (top.kind !== 'flow') return null
      const list: CellPart<N> & { kind: 'list' } = { kind: 'list', ordered, items: [] }
      top.parts.push(list)
      stack.push({ kind: 'list', list })
    } else {
      if (top.kind !== 'list' || top.list.ordered !== ordered) return null
      stack.pop()
    }
  }
  return found && stack.length === 1 ? root : null
}
