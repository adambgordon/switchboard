import { describe, expect, it } from 'vitest'
import { countConversationalMessages } from '../src/shared/messageCount'
import type { TranscriptMessage } from '../src/shared/types'

const message = (
  role: TranscriptMessage['role'],
  blocks: TranscriptMessage['blocks'],
  userKind?: TranscriptMessage['userKind']
): TranscriptMessage => ({
  uuid: '',
  role,
  userKind,
  blocks,
  timestamp: null,
  isSidechain: false
})

describe('countConversationalMessages', () => {
  it('counts visible human and assistant prose while excluding transcript plumbing', () => {
    const messages: TranscriptMessage[] = [
      message('user', [{ kind: 'text', text: 'Please fix it' }], 'human'),
      message('assistant', [
        { kind: 'text', text: 'I will inspect it.' },
        { kind: 'tool_use', id: 't1', name: 'Read', input: {} }
      ]),
      message('assistant', [{ kind: 'tool_use', id: 't2', name: 'Edit', input: {} }]),
      message('user', [{ kind: 'tool_result', toolUseId: 't2', text: 'done', isError: false }], 'tool_result'),
      message('user', [{ kind: 'text', text: '[Request interrupted by user]' }], 'interrupted'),
      message('assistant', [{ kind: 'text', text: '   ' }]),
      message('user', [{ kind: 'image', alt: 'screenshot' }], 'human')
    ]

    expect(countConversationalMessages(messages)).toBe(3)
  })
})
