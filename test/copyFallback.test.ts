import { describe, expect, it, vi } from 'vitest'
import { copyWithFallback } from '../src/renderer/lib/copyFallback'
import { assembleCopy, type CopyMode, type CopyNode, type CopySelection } from '../src/renderer/lib/mdCopy'
import { markdownCopyNodes } from '../src/renderer/lib/mdCopyAst'

describe('selection serialization fallback', () => {
  it.each(['markdown', 'plain'] as const)('copies successful %s output in one attempt', mode => {
    const serialize = vi.fn(() => '**kept**')
    expect(copyWithFallback(mode, serialize)).toEqual({ outcome: 'copied', text: '**kept**' })
    expect(serialize.mock.calls).toEqual([[mode]])
  })
  it.each(['markdown', 'plain'] as const)('does not retry successful empty %s output', mode => {
    const serialize = vi.fn(() => '')
    expect(copyWithFallback(mode, serialize)).toEqual({ outcome: 'copied', text: '' })
    expect(serialize.mock.calls).toEqual([[mode]])
  })
  it('retries a Markdown failure once in plain mode', () => {
    const serialize = vi.fn((mode: CopyMode) => {
      if (mode === 'markdown') throw new Error('cannot serialize')
      return 'plain result'
    })
    expect(copyWithFallback('markdown', serialize)).toEqual({ outcome: 'plain-fallback', text: 'plain result' })
    expect(serialize.mock.calls).toEqual([['markdown'], ['plain']])
  })
  it('accepts empty plain output after a Markdown failure', () => {
    const serialize = vi.fn((mode: CopyMode) => {
      if (mode === 'markdown') throw null
      return ''
    })
    expect(copyWithFallback('markdown', serialize)).toEqual({ outcome: 'plain-fallback', text: '' })
    expect(serialize.mock.calls).toEqual([['markdown'], ['plain']])
  })
  it('contains both serialization failures without partial output', () => {
    const serialize = vi.fn(() => { throw new Error('private selected content') })
    expect(copyWithFallback('markdown', serialize)).toEqual({ outcome: 'failed', text: '' })
    expect(serialize.mock.calls).toEqual([['markdown'], ['plain']])
  })
  it('does not retry a failed plain request', () => {
    const serialize = vi.fn(() => { throw new Error('failed') })
    expect(copyWithFallback('plain', serialize)).toEqual({ outcome: 'failed', text: '' })
    expect(serialize.mock.calls).toEqual([['plain']])
  })
  it.each(['code', 'math'] as const)('falls back for the whole selection across partial %s wrappers', kind => {
    const atom = (value: string) => kind === 'code' ? '`' + value + '`' : '$' + value + '$'
    const source = 'L *x' + atom('a') + '*_' + atom('b') + '**z**y_ R' + (kind === 'math' ? '\n\n$$\nx\n$$' : '')
    const nodes = markdownCopyNodes(source).slice(0, 1), selection: CopySelection = new Map()
    const visit = (node: CopyNode): void => {
      if ('value' in node && ['a', 'b', 'z'].includes(node.value)) selection.set(node, { from: 0, to: node.value.length })
      if ('children' in node) node.children.forEach(visit)
    }
    nodes.forEach(visit)
    const sections = [{ label: 'Assistant', isSidechain: false, nodes }]
    const serialize = vi.fn((mode: CopyMode) => assembleCopy(sections, { mode, intent: 'selection', selection }))
    expect(() => serialize('markdown')).toThrow('Unrepresentable adjacent Markdown atoms')
    serialize.mockClear()
    expect(copyWithFallback('markdown', serialize)).toEqual({ outcome: 'plain-fallback', text: 'abz' })
    expect(serialize.mock.calls).toEqual([['markdown'], ['plain']])
    // Removing the collision proves that z's bold style was otherwise eligible.
    const first = [...selection.keys()].find(node => 'value' in node && node.value === 'a')!
    selection.delete(first)
    expect(serialize('markdown')).toBe(kind === 'code' ? '`b`**z**' : '$b$**z**')
  })
})
