import { describe, expect, it } from 'vitest'
import { rowsToMarkdownTable, turnMarkdown } from '../src/renderer/lib/clipboard'
import type { TranscriptBlock, TranscriptMessage } from '../src/shared/types'

describe('rowsToMarkdownTable', () => {
  it('builds a padded markdown table with a separator row', () => {
    const md = rowsToMarkdownTable([
      ['Name', 'Size'],
      ['foo', '12'],
      ['bar', '7']
    ])
    expect(md).toBe(
      ['| Name | Size |', '| ---- | ---- |', '| foo  | 12   |', '| bar  | 7    |'].join('\n')
    )
  })

  it('escapes pipes and collapses newlines in cells', () => {
    const md = rowsToMarkdownTable([['a|b'], ['c\nd']])
    expect(md).toBe(['| a\\|b |', '| ---- |', '| c d  |'].join('\n'))
  })

  it('pads short columns to the 3-char minimum (so --- fits)', () => {
    const md = rowsToMarkdownTable([['x'], ['y']])
    expect(md).toBe(['| x   |', '| --- |', '| y   |'].join('\n'))
  })

  it('returns empty string for no rows', () => {
    expect(rowsToMarkdownTable([])).toBe('')
  })
})

describe('turnMarkdown', () => {
  const msg = (blocks: TranscriptBlock[]): TranscriptMessage => ({
    uuid: 'u',
    role: 'assistant',
    blocks,
    timestamp: null,
    isSidechain: false
  })

  it('returns text blocks verbatim (markdown preserved) and skips non-text blocks', () => {
    const out = turnMarkdown([
      msg([
        { kind: 'text', text: '# Title\n\n**bold**, `code`, and:\n- a\n- b' },
        { kind: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
        { kind: 'text', text: 'after the tool' }
      ])
    ])
    expect(out).toBe('# Title\n\n**bold**, `code`, and:\n- a\n- b\n\nafter the tool')
  })

  it('joins text across messages in a group with a blank line', () => {
    const out = turnMarkdown([msg([{ kind: 'text', text: 'one' }]), msg([{ kind: 'text', text: 'two' }])])
    expect(out).toBe('one\n\ntwo')
  })

  it('returns empty string when a turn has no text blocks', () => {
    expect(turnMarkdown([msg([{ kind: 'tool_use', id: 't', name: 'X', input: null }])])).toBe('')
  })
})
