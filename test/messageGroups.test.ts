import { describe, expect, it } from 'vitest'
import {
  buildRenderItems,
  buildTranscript,
  type RenderItem,
  type Section,
  type ToolRunItem,
  type TurnItem
} from '../src/renderer/lib/messageGroups'
import type { TranscriptMessage } from '../src/shared/types'

let counter = 0
function msg(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    uuid: over.uuid ?? `u${counter++}`,
    role: over.role ?? 'assistant',
    userKind: over.userKind,
    blocks: over.blocks ?? [],
    timestamp: over.timestamp ?? null,
    isSidechain: over.isSidechain ?? false
  }
}

const text = (t: string, over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  msg({ role: 'assistant', blocks: [{ kind: 'text', text: t }], ...over })
const human = (t = 'hi', over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  msg({ role: 'user', userKind: 'human', blocks: [{ kind: 'text', text: t }], ...over })
const call = (
  id: string,
  name = 'Edit',
  input: unknown = { x: 1 },
  over: Partial<TranscriptMessage> = {}
): TranscriptMessage => msg({ role: 'assistant', blocks: [{ kind: 'tool_use', id, name, input }], ...over })
const textCall = (t: string, id: string, name = 'Edit'): TranscriptMessage =>
  msg({
    role: 'assistant',
    blocks: [
      { kind: 'text', text: t },
      { kind: 'tool_use', id, name, input: {} }
    ]
  })
const result = (toolUseId: string, isError = false, over: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  msg({
    role: 'user',
    userKind: 'tool_result',
    blocks: [{ kind: 'tool_result', toolUseId, text: 'out', isError }],
    ...over
  })
const interrupted = (): TranscriptMessage =>
  msg({
    role: 'user',
    userKind: 'interrupted',
    blocks: [{ kind: 'text', text: '[Request interrupted by user]' }]
  })

const kinds = (items: RenderItem[]): string[] => items.map((i) => i.kind)

describe('buildRenderItems', () => {
  it('renders assistant text as a Claude turn', () => {
    const items = buildRenderItems([text('hello')])
    expect(items).toHaveLength(1)
    const t = items[0] as TurnItem
    expect(t.kind).toBe('turn')
    expect(t.label).toBe('Claude')
    expect(t.isAssistant).toBe(true)
  })

  it('coalesces consecutive assistant text into one turn', () => {
    const items = buildRenderItems([text('a'), text('b')])
    expect(items).toHaveLength(1)
    expect((items[0] as TurnItem).messages).toHaveLength(2)
  })

  it('collapses a call + its result into one tool run (count 1, paired by id)', () => {
    const items = buildRenderItems([call('t1'), result('t1')])
    expect(kinds(items)).toEqual(['toolrun'])
    const run = items[0] as ToolRunItem
    expect(run.count).toBe(1)
    expect(run.pairs).toHaveLength(1)
    expect(run.pairs[0].call?.id).toBe('t1')
    expect(run.pairs[0].result?.text).toBe('out')
  })

  it('coalesces consecutive call/result pairs across turns into ONE run', () => {
    const items = buildRenderItems([
      call('t1'),
      result('t1'),
      call('t2'),
      result('t2'),
      call('t3'),
      result('t3')
    ])
    expect(kinds(items)).toEqual(['toolrun'])
    const run = items[0] as ToolRunItem
    expect(run.count).toBe(3)
    expect(run.pairs.map((p) => [p.call?.id, p.result != null])).toEqual([
      ['t1', true],
      ['t2', true],
      ['t3', true]
    ])
  })

  it('splits narration text out of a tool-calling message into a preceding turn', () => {
    const items = buildRenderItems([
      textCall('Now applying the edits.', 't1'),
      result('t1'),
      call('t2'),
      result('t2')
    ])
    expect(kinds(items)).toEqual(['turn', 'toolrun'])
    expect((items[0] as TurnItem).label).toBe('Claude')
    expect((items[1] as ToolRunItem).count).toBe(2)
  })

  it('narration between tool activity breaks a run in two', () => {
    const items = buildRenderItems([call('t1'), result('t1'), text('verifying'), call('t2'), result('t2')])
    expect(kinds(items)).toEqual(['toolrun', 'turn', 'toolrun'])
    expect((items[0] as ToolRunItem).count).toBe(1)
    expect((items[2] as ToolRunItem).count).toBe(1)
  })

  it('a human turn breaks a run', () => {
    const items = buildRenderItems([call('t1'), result('t1'), human('next'), call('t2'), result('t2')])
    expect(kinds(items)).toEqual(['toolrun', 'turn', 'toolrun'])
    expect((items[1] as TurnItem).label).toBe('You')
  })

  it('an interrupt is its own item and flushes the run', () => {
    const items = buildRenderItems([call('t1'), result('t1'), interrupted()])
    expect(kinds(items)).toEqual(['toolrun', 'interrupt'])
  })

  it('never merges sidechain tool activity with main-chain', () => {
    const items = buildRenderItems([
      call('t1'),
      result('t1'),
      call('t2', 'Read', {}, { isSidechain: true }),
      result('t2', false, { isSidechain: true })
    ])
    expect(kinds(items)).toEqual(['toolrun', 'toolrun'])
    expect((items[0] as ToolRunItem).isSidechain).toBe(false)
    expect((items[1] as ToolRunItem).isSidechain).toBe(true)
  })

  it('leaves a pending call (no result) with a null result and still counts it', () => {
    const items = buildRenderItems([call('t1')])
    const run = items[0] as ToolRunItem
    expect(run.count).toBe(1)
    expect(run.pairs[0].result).toBeNull()
  })

  it('pairs parallel calls to batched results by id', () => {
    const twoCalls = msg({
      role: 'assistant',
      blocks: [
        { kind: 'tool_use', id: 'a', name: 'Read', input: {} },
        { kind: 'tool_use', id: 'b', name: 'Edit', input: {} }
      ]
    })
    const twoResults = msg({
      role: 'user',
      userKind: 'tool_result',
      blocks: [
        { kind: 'tool_result', toolUseId: 'b', text: 'B', isError: false },
        { kind: 'tool_result', toolUseId: 'a', text: 'A', isError: false }
      ]
    })
    const items = buildRenderItems([twoCalls, twoResults])
    const run = items[0] as ToolRunItem
    expect(run.count).toBe(2)
    expect(run.pairs.map((p) => [p.call?.id, p.result?.text])).toEqual([
      ['a', 'A'],
      ['b', 'B']
    ])
  })

  it('uses the Codex assistant label for the agent turn', () => {
    const items = buildRenderItems([text('hi')], 'codex')
    expect((items[0] as TurnItem).label).toBe('Codex')
  })
})

describe('buildTranscript (sections)', () => {
  it('collapses repeated agent beats + runs under one section header', () => {
    const items = buildTranscript([
      textCall('On it.', 't1'),
      result('t1'),
      textCall('Next.', 't2'),
      result('t2'),
      textCall('Done.', 't3'),
      result('t3')
    ])
    expect(items).toHaveLength(1)
    const s = items[0] as Section
    expect(s.kind).toBe('section')
    expect(s.label).toBe('Claude')
    expect(s.agent).toBe('claude')
    expect(s.items.map((i) => i.kind)).toEqual([
      'turn',
      'toolrun',
      'turn',
      'toolrun',
      'turn',
      'toolrun'
    ])
  })

  it('separates a You section from the following agent section', () => {
    const items = buildTranscript([human('hi'), text('hello'), call('t1'), result('t1')])
    expect(items.map((i) => (i.kind === 'section' ? i.label : i.kind))).toEqual(['You', 'Claude'])
    expect((items[1] as Section).items.map((i) => i.kind)).toEqual(['turn', 'toolrun'])
  })

  it('labels an agent section that begins with a tool run', () => {
    const items = buildTranscript([call('t1'), result('t1')])
    const s = items[0] as Section
    expect(s.label).toBe('Claude')
    expect(s.isAssistant).toBe(true)
    expect(s.items[0].kind).toBe('toolrun')
  })

  it('keeps an interrupt standalone between sections', () => {
    const items = buildTranscript([text('a'), interrupted(), text('b')])
    expect(items.map((i) => i.kind)).toEqual(['section', 'interrupt', 'section'])
  })

  it('never merges a sidechain section with the main-chain section', () => {
    const items = buildTranscript([
      call('t1'),
      result('t1'),
      call('t2', 'Read', {}, { isSidechain: true }),
      result('t2', false, { isSidechain: true })
    ])
    expect(items).toHaveLength(2)
    expect((items[0] as Section).isSidechain).toBe(false)
    expect((items[1] as Section).isSidechain).toBe(true)
  })

  it('uses the Codex label for the section', () => {
    const items = buildTranscript([text('hi'), call('t1'), result('t1')], 'codex')
    expect((items[0] as Section).label).toBe('Codex')
    expect((items[0] as Section).agent).toBe('codex')
  })
})
