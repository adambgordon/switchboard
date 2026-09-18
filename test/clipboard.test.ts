import { describe, expect, it } from 'vitest'
import {
  conversationText,
  markdownToPlainText,
  rowsToMarkdownTable,
  rowsToPlainText,
  turnText
} from '../src/renderer/lib/clipboard'
import type { TranscriptBlock, TranscriptMessage } from '../src/shared/types'

describe('rowsToPlainText', () => {
  it('joins cells with tabs and rows with newlines', () => {
    expect(
      rowsToPlainText([
        ['Name', 'Size'],
        ['foo', '12']
      ])
    ).toBe('Name\tSize\nfoo\t12')
  })

  it('quotes embedded newlines without changing cell content', () => {
    expect(rowsToPlainText([['a\nb', 'c']])).toBe('"a\nb"\tc')
  })

  it('preserves the ragged row shape of a selection across table rows', () => {
    expect(rowsToPlainText([['tail', 'right'], ['left']])).toBe('tail\tright\nleft')
  })

  it('preserves an empty cell swept between selected cells', () => {
    expect(rowsToPlainText([['a', '', 'c']])).toBe('a\t\tc')
  })
})

describe('markdownToPlainText', () => {
  it('drops emphasis, headings, and link syntax but keeps the words', () => {
    expect(markdownToPlainText('## Title\n\nSome **bold** and a [link](http://x.com).')).toBe(
      'Title\n\nSome bold and a link.'
    )
  })

  it('keeps a code block’s body without its fence', () => {
    expect(markdownToPlainText('Run:\n\n```bash\nls -la\n```')).toBe('Run:\n\nls -la')
  })

  it('keeps list markers, because the rendered view shows bullets too', () => {
    expect(markdownToPlainText('- one\n- two')).toBe('- one\n- two')
    expect(markdownToPlainText('1. first\n2. second')).toBe('1. first\n2. second')
  })

  it('keeps ordered-list starts and task state', () => {
    expect(markdownToPlainText('3. third\n4. fourth')).toBe('3. third\n4. fourth')
    expect(markdownToPlainText('- [x] done\n- [ ] todo')).toBe('- [x] done\n- [ ] todo')
  })

  it('keeps nested task-list indentation attached to its parent', () => {
    expect(markdownToPlainText('- [x] outer\n  - child\n- end')).toBe('- [x] outer\n  - child\n- end')
  })

  it('renders a GFM table as tab-separated rows rather than leaking pipes', () => {
    expect(markdownToPlainText('| A | B |\n| --- | --- |\n| 1 | 2 |')).toBe('A\tB\n1\t2')
  })

  it('keeps inline code content', () => {
    expect(markdownToPlainText('call `foo()` now')).toBe('call foo() now')
  })
})


describe('whole plain copy structure', () => {
  it('keeps indentation and payload blank lines', () => {
    expect(markdownToPlainText('```text\n  one\n\ttwo\n\n```')).toBe('  one\n\ttwo\n')
  })
  it('copies gated math as LaTeX while leaving shell sigils alone', () => {
    expect(markdownToPlainText('Use $PATH.')).toBe('Use $PATH.')
    expect(markdownToPlainText('L \\(x^2\\) R\n\n\\[\ny^2\n\\]')).toBe('L x^2 R\n\ny^2')
  })
  it('keeps image labels and reads footnotes in rendered order', () => {
    expect(markdownToPlainText('![diagram](https://example.org/image.png)')).toBe('diagram')
    expect(markdownToPlainText('Before[^a].\n\n[^a]: Note body\n\nAfter.')).toBe('Before1.\n\nAfter.\n\n1. Note body')
  })
})

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

describe('turnText', () => {
  const msg = (blocks: TranscriptBlock[]): TranscriptMessage => ({
    uuid: 'u',
    role: 'assistant',
    blocks,
    timestamp: null,
    isSidechain: false
  })

  it('returns text blocks verbatim (markdown preserved) and skips non-text blocks', () => {
    const out = turnText([
      msg([
        { kind: 'text', text: '# Title\n\n**bold**, `code`, and:\n- a\n- b' },
        { kind: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
        { kind: 'text', text: 'after the tool' }
      ])
    ])
    expect(out).toBe('# Title\n\n**bold**, `code`, and:\n- a\n- b\n\nafter the tool')
  })

  it('joins text across messages in a group with a blank line', () => {
    const out = turnText([msg([{ kind: 'text', text: 'one' }]), msg([{ kind: 'text', text: 'two' }])])
    expect(out).toBe('one\n\ntwo')
  })

  it('returns empty string when a turn has no text blocks', () => {
    expect(turnText([msg([{ kind: 'tool_use', id: 't', name: 'X', input: null }])])).toBe('')
  })
})

describe('conversationText', () => {
  it('copies role-labeled prose while excluding tool calls and results', () => {
    const messages: TranscriptMessage[] = [
      {
        uuid: 'u1',
        role: 'user',
        userKind: 'human',
        blocks: [
          { kind: 'text', text: '## Request' },
          { kind: 'image', alt: 'screenshot' }
        ],
        timestamp: null,
        isSidechain: false
      },
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [
          { kind: 'text', text: '**Working**' },
          { kind: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'secret output' } }
        ],
        timestamp: null,
        isSidechain: false
      },
      {
        uuid: 'r1',
        role: 'user',
        userKind: 'tool_result',
        blocks: [{ kind: 'tool_result', toolUseId: 't1', text: 'secret result', isError: false }],
        timestamp: null,
        isSidechain: false
      },
      {
        uuid: 'a2',
        role: 'assistant',
        blocks: [{ kind: 'text', text: 'Done' }],
        timestamp: null,
        isSidechain: false
      }
    ]

    expect(conversationText(messages, 'codex')).toBe(
      [
        '**You:**',
        '',
        '## Request',
        '',
        'screenshot',
        '',
        '---',
        '',
        '**Codex:**',
        '',
        '**Working**',
        '',
        'Done'
      ].join('\n')
    )
  })

  it('uses the Claude label and preserves sub-agent attribution', () => {
    const messages: TranscriptMessage[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'text', text: 'Delegated finding' }],
        timestamp: null,
        isSidechain: true
      }
    ]

    expect(conversationText(messages, 'claude')).toBe(
      '**Claude (Sub-agent):**\n\nDelegated finding'
    )
  })

  it('returns empty text when the conversation has no prose', () => {
    const messages: TranscriptMessage[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'tool_use', id: 't1', name: 'Read', input: { file: 'x' } }],
        timestamp: null,
        isSidechain: false
      },
      {
        uuid: 'r1',
        role: 'user',
        userKind: 'tool_result',
        blocks: [{ kind: 'tool_result', toolUseId: 't1', text: 'contents', isError: false }],
        timestamp: null,
        isSidechain: false
      }
    ]

    expect(conversationText(messages, 'claude')).toBe('')
  })

  it('keeps list numbering and task state in a plain conversation export', () => {
    const messages: TranscriptMessage[] = [
      {
        uuid: 'a1',
        role: 'assistant',
        blocks: [{ kind: 'text', text: '3. third\n4. fourth\n\n- [x] done\n- [ ] todo' }],
        timestamp: null,
        isSidechain: false
      }
    ]

    expect(conversationText(messages, 'claude', 'plain')).toBe(
      'Claude:\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] todo'
    )
  })
})
