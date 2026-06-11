import { describe, expect, it } from 'vitest'
import { buildGroups } from '../src/renderer/lib/messageGroups'
import type { TranscriptMessage } from '../src/shared/types'

let counter = 0
function msg(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    uuid: over.uuid ?? `u${counter++}`,
    role: over.role ?? 'assistant',
    userKind: over.userKind,
    blocks: over.blocks ?? [{ kind: 'text', text: 'x' }],
    timestamp: null,
    isSidechain: over.isSidechain ?? false
  }
}

const claude = (over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  msg({ role: 'assistant', ...over })
const human = (over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  msg({ role: 'user', userKind: 'human', blocks: [{ kind: 'text', text: 'hi' }], ...over })
const result = (isError = false, over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  msg({
    role: 'user',
    userKind: 'tool_result',
    blocks: [{ kind: 'tool_result', toolUseId: 't', text: 'out', isError }],
    ...over
  })
const interrupted = (over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  msg({
    role: 'user',
    userKind: 'interrupted',
    blocks: [{ kind: 'text', text: '[Request interrupted by user]' }],
    ...over
  })

describe('buildGroups', () => {
  it('coalesces a run of same-source messages under one group', () => {
    const groups = buildGroups([claude(), claude(), claude()])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Claude')
    expect(groups[0].messages).toHaveLength(3)
  })

  it('starts a new group when the source changes (Claude → Result)', () => {
    const groups = buildGroups([claude(), claude(), result(), result()])
    expect(groups.map((g) => [g.label, g.messages.length])).toEqual([
      ['Claude', 2],
      ['Result', 2]
    ])
  })

  it('keeps Result and Error as separate groups (different label)', () => {
    const groups = buildGroups([result(false), result(true)])
    expect(groups.map((g) => g.label)).toEqual(['Result', 'Error'])
    expect(groups[1].isError).toBe(true)
  })

  it('never coalesces across an interrupt sentinel', () => {
    const groups = buildGroups([claude(), interrupted(), claude()])
    expect(groups).toHaveLength(3)
    expect(groups.map((g) => g.interrupted)).toEqual([false, true, false])
  })

  it('does not merge sidechain with main-chain even at the same label', () => {
    const groups = buildGroups([claude(), claude({ isSidechain: true })])
    expect(groups).toHaveLength(2)
    expect(groups[1].isSidechain).toBe(true)
  })

  it('groups consecutive human (You) turns', () => {
    const groups = buildGroups([human(), human()])
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('You')
  })

  it('keys each group by its first message uuid', () => {
    const groups = buildGroups([
      claude({ uuid: 'a1' }),
      claude({ uuid: 'a2' }),
      result(false, { uuid: 'r1' })
    ])
    expect(groups.map((g) => g.key)).toEqual(['a1', 'r1'])
  })
})
