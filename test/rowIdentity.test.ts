import { describe, expect, it } from 'vitest'
import type { ConversationMeta, PtyState } from '../src/shared/types'
import {
  displayTitleForRow,
  isParkedOnlyRow,
  isUnlinkedRow,
  resolveRowLiveState
} from '../src/renderer/lib/rowIdentity'

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

describe('displayTitleForRow', () => {
  it('names the background agent when the terminal has no conversation of its own', () => {
    expect(displayTitleForRow(pty({ parkedJob: PARKED }), meta({ messageCount: 0 }))).toBe(
      'Find retrier example in mio'
    )
  })

  it('falls back to the row title when the agent has no name yet', () => {
    const unnamed = { shortId: '6e76e54b', name: '' }
    expect(
      displayTitleForRow(pty({ parkedJob: unnamed }), meta({ messageCount: 0, title: 'New conversation' }))
    ).toBe('New conversation')
  })

  it('leaves an ordinary conversation alone, even one that launched an agent', () => {
    expect(displayTitleForRow(pty({ parkedJob: PARKED }), meta({ title: 'Real work' }))).toBe(
      'Real work'
    )
    expect(displayTitleForRow(pty(), meta({ title: 'Real work' }))).toBe('Real work')
    expect(displayTitleForRow(null, meta({ title: 'Real work' }))).toBe('Real work')
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

describe('resolveRowLiveState', () => {
  // What an unindexed session's meta actually looks like: App synthesizes it from the live process,
  // so it has no messages and no turn-state of its own.
  const synth = { messageCount: 0, title: 'New conversation' }

  it('gives a parked-only row no state, even when one would otherwise resolve', () => {
    // The reported bug. A runtime input notification resolves to `asking` straight off the pty,
    // without consulting the transcript at all — so an ungated parked row pulses for work that is
    // not its own. Asserting `null` here is only meaningful because the same row WITHOUT the parked
    // marker resolves to something (next assertion).
    const parked = pty({ parkedJob: PARKED, inputRequestedAt: 500 })
    expect(resolveRowLiveState(parked, meta(synth), 0, false, undefined)).toBe(null)
    expect(resolveRowLiveState(pty({ inputRequestedAt: 500 }), meta(synth), 0, false, undefined)).toBe(
      'asking'
    )
  })

  it('gives an unbound Codex row no state, even when one would otherwise resolve', () => {
    const unbound = pty({ agent: 'codex', provisional: true, inputRequestedAt: 500 })
    expect(resolveRowLiveState(unbound, meta(synth), 0, false, undefined)).toBe(null)
  })

  it('still resolves normally for a conversation that merely launched an agent', () => {
    // The regression this row exists to avoid re-introducing: the parked marker is never cleared, so
    // an ordinary conversation keeps it for life and must go on getting a real dot.
    const launcher = pty({ parkedJob: PARKED })
    const working = meta({ messageCount: 3, turnState: 'in_progress', lastActivityAt: 50 })
    expect(resolveRowLiveState(launcher, working, 0, false, undefined)).toBe('working')
  })

  it('resolves an ordinary live row', () => {
    const working = meta({ turnState: 'in_progress', lastActivityAt: 50 })
    expect(resolveRowLiveState(pty(), working, 0, false, undefined)).toBe('working')
    // Looking at a finished turn counts as seeing it.
    const finished = meta({ turnState: 'awaiting', turnEndedAt: 100 })
    expect(resolveRowLiveState(pty(), finished, 0, false, undefined)).toBe('awaiting')
    expect(resolveRowLiveState(pty(), finished, 0, true, undefined)).toBe('quiet')
  })

  it('has no state without a live terminal', () => {
    expect(resolveRowLiveState(null, meta({ turnState: 'in_progress', lastActivityAt: 50 }), 0, false, undefined)).toBe(
      null
    )
  })

  it('applies a manual unread mark, and ignores one a later turn superseded', () => {
    // Proves the fold-in is a real isManualUnread call and not a null-check on the timestamp: both
    // marks below are non-null, and only the one AFTER the turn ended still applies.
    const seen = meta({ turnState: 'awaiting', turnEndedAt: 100 })
    expect(resolveRowLiveState(pty(), seen, 200, false, undefined)).toBe('quiet')
    expect(resolveRowLiveState(pty(), seen, 200, false, 150)).toBe('awaiting')
    expect(resolveRowLiveState(pty(), seen, 200, false, 50)).toBe('quiet')
  })
})
