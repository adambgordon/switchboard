import { describe, it, expect } from 'vitest'
import { resolveLiveState, isManualUnread } from '../src/renderer/lib/liveness'
import type { ConversationMeta } from '../src/shared/types'

/** Live process spawn time (ms epoch). Carryover = activity BEFORE this; live work = AFTER. */
const SPAWN = 1_780_000_000_000
const BEFORE = SPAWN - 60_000 // 1 min before the process started → carryover from a dead run
const AFTER = SPAWN + 60_000 // 1 min after → genuine work by the current process

/** Build a ConversationMeta with sane defaults; override only what a case cares about. */
function meta(p: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    sessionId: 's',
    cwd: '/x',
    title: 't',
    preview: '',
    gitBranch: null,
    mtime: SPAWN,
    messageCount: 1,
    version: null,
    sizeBytes: 0,
    model: null,
    outputTokens: 0,
    inputTokens: 0,
    firstActivityAt: null,
    ...p
  }
}

describe('resolveLiveState — carryover demotion (in_progress turn predating the live process)', () => {
  const carryover = meta({ turnState: 'in_progress', lastActivityAt: BEFORE })

  it('demotes to awaiting when the turn predates the live process (unread, not looking)', () => {
    expect(resolveLiveState(carryover, 0, false, false, SPAWN)).toBe('awaiting')
  })

  it('is quiet while looked at', () => {
    expect(resolveLiveState(carryover, 0, true, false, SPAWN)).toBe('quiet')
  })

  it('is quiet once seen (seen marker at/after the pre-resume activity)', () => {
    expect(resolveLiveState(carryover, SPAWN, false, false, SPAWN)).toBe('quiet')
  })

  it('does NOT demote a turn whose activity postdates the process (genuine live work)', () => {
    const working = meta({ turnState: 'in_progress', lastActivityAt: AFTER })
    expect(resolveLiveState(working, 0, false, false, SPAWN)).toBe('working')
  })

  it('does NOT demote a long-running tool (tool_use written well after spawn)', () => {
    const longTool = meta({ turnState: 'in_progress', lastActivityAt: SPAWN + 5 * 60_000 })
    expect(resolveLiveState(longTool, 0, false, false, SPAWN)).toBe('working')
  })

  it('does NOT demote when the spawn time is unknown (null startedAt → no demotion)', () => {
    expect(resolveLiveState(carryover, 0, false, false, null)).toBe('working')
  })

  it('does NOT demote at the exact boundary (startedAt == lastActivityAt)', () => {
    const atBoundary = meta({ turnState: 'in_progress', lastActivityAt: SPAWN })
    expect(resolveLiveState(atBoundary, 0, false, false, SPAWN)).toBe('working')
  })
})

describe('resolveLiveState — non-in_progress states (startedAt is inert)', () => {
  it('awaiting: solid when unread, quiet when looked at or seen', () => {
    const m = meta({ turnState: 'awaiting', turnEndedAt: SPAWN, lastActivityAt: SPAWN })
    expect(resolveLiveState(m, 0, false, false, SPAWN)).toBe('awaiting')
    expect(resolveLiveState(m, 0, true, false, SPAWN)).toBe('quiet')
    expect(resolveLiveState(m, SPAWN, false, false, SPAWN)).toBe('quiet')
  })

  it('awaiting + manual unread forces the solid dot even when seen', () => {
    const m = meta({ turnState: 'awaiting', turnEndedAt: SPAWN, lastActivityAt: SPAWN })
    expect(resolveLiveState(m, SPAWN, false, true, SPAWN)).toBe('awaiting')
  })

  it('awaiting_input: asking when unread, quiet when looked at', () => {
    const m = meta({ turnState: 'awaiting_input', awaitingTool: 'AskUserQuestion', lastActivityAt: SPAWN })
    expect(resolveLiveState(m, 0, false, false, SPAWN)).toBe('asking')
    expect(resolveLiveState(m, 0, true, false, SPAWN)).toBe('quiet')
  })

  it('awaiting_input + manual unread forces the pulse back — even when looked at or seen', () => {
    const m = meta({ turnState: 'awaiting_input', awaitingTool: 'AskUserQuestion', lastActivityAt: SPAWN })
    // looked at (would be quiet) → asking
    expect(resolveLiveState(m, 0, true, true, SPAWN)).toBe('asking')
    // already seen (would be quiet) → asking
    expect(resolveLiveState(m, SPAWN, false, true, SPAWN)).toBe('asking')
  })

  it('no turn-state yet (freshly spawned / provisional) is quiet, never working', () => {
    expect(resolveLiveState(meta({ provisional: true }), 0, false, false, SPAWN)).toBe('quiet')
    expect(resolveLiveState(undefined, 0, false, false, SPAWN)).toBe('quiet')
  })
})

describe('isManualUnread', () => {
  it('false when no mark is set', () => {
    expect(isManualUnread(undefined, meta({ turnEndedAt: SPAWN }))).toBe(false)
  })

  it('true while the mark is at/after the last turn end', () => {
    expect(isManualUnread(SPAWN, meta({ turnEndedAt: SPAWN }))).toBe(true)
  })

  it('false once a newer turn supersedes the mark', () => {
    expect(isManualUnread(SPAWN, meta({ turnEndedAt: SPAWN + 1 }))).toBe(false)
  })
})
