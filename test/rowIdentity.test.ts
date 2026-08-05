import { describe, expect, it } from 'vitest'
import type { ConversationMeta, PtyState } from '../src/shared/types'
import { isParkedOnlyRow, isUnlinkedRow } from '../src/renderer/lib/rowIdentity'

function pty(over: Partial<PtyState> = {}): PtyState {
  return {
    ptyId: 'pty-1',
    sessionId: 'a',
    agent: 'claude',
    cwd: '/repo',
    title: 'Conversation',
    status: 'idle',
    lastActivity: 20,
    startedAt: 10,
    inputRequestedAt: null,
    origin: 'new',
    provisional: false,
    parkedJob: null,
    ...over
  }
}

function meta(over: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    sessionId: 'a',
    agent: 'claude',
    cwd: '/repo',
    title: 'Conversation',
    preview: '',
    gitBranch: null,
    mtime: 0,
    messageCount: 3,
    version: null,
    sizeBytes: 0,
    model: null,
    outputTokens: 0,
    inputTokens: 0,
    contextTokens: 0,
    firstActivityAt: null,
    ...over
  }
}

const PARKED = { shortId: '6e76e54b', name: 'Find retrier example in mio' }

describe('isParkedOnlyRow', () => {
  it('is true for a live terminal with a parked agent and no conversation of its own', () => {
    expect(isParkedOnlyRow(pty({ parkedJob: PARKED }), meta({ messageCount: 0 }))).toBe(true)
  })

  it('is FALSE once the session has a conversation of its own', () => {
    // The case that broke: an ordinary conversation that merely launched a background agent keeps the
    // marker forever, so the marker alone must never be enough.
    expect(isParkedOnlyRow(pty({ parkedJob: PARKED }), meta({ messageCount: 3 }))).toBe(false)
  })

  it('is false without a parked agent, however empty the conversation', () => {
    expect(isParkedOnlyRow(pty(), meta({ messageCount: 0 }))).toBe(false)
  })

  it('is false with no live terminal at all', () => {
    expect(isParkedOnlyRow(null, meta({ messageCount: 0 }))).toBe(false)
  })
})

describe('isUnlinkedRow', () => {
  it('covers an unbound Codex terminal', () => {
    expect(isUnlinkedRow(pty({ agent: 'codex', provisional: true }), meta({ messageCount: 0 }))).toBe(
      true
    )
  })

  it('covers a Claude terminal whose work is in a background agent', () => {
    expect(isUnlinkedRow(pty({ parkedJob: PARKED }), meta({ messageCount: 0 }))).toBe(true)
  })

  it('does not cover an ordinary live conversation', () => {
    expect(isUnlinkedRow(pty(), meta())).toBe(false)
  })

  it('does not cover a live conversation that launched a background agent', () => {
    expect(isUnlinkedRow(pty({ parkedJob: PARKED }), meta({ messageCount: 3 }))).toBe(false)
  })

  it('does not cover a row with no live terminal', () => {
    expect(isUnlinkedRow(null, meta({ messageCount: 0 }))).toBe(false)
  })
})
