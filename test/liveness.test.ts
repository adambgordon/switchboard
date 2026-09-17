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
    agent: 'claude',
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
    inputBaseTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 0,
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

  it('awaiting_input + manual unread still pulses when its timestamp is malformed', () => {
    const m = meta({ turnState: 'awaiting_input', lastActivityAt: null })
    expect(resolveLiveState(m, 0, false, true, SPAWN, null)).toBe('asking')
  })

  it('no turn-state yet (freshly spawned / provisional) is quiet, never working', () => {
    expect(resolveLiveState(meta({ provisional: true }), 0, false, false, SPAWN)).toBe('quiet')
    expect(resolveLiveState(undefined, 0, false, false, SPAWN)).toBe('quiet')
  })
})

/**
 * Claude's own busy/idle, which the dot uses ONLY to upgrade a dim row to breathing.
 *
 * Deliberately narrower than the live-session cap's use of the same fact: the cap reads busy as work
 * in flight and refuses to stop the terminal, while the dot keeps showing a question or an unseen
 * finished turn, because those are things for the user to read and "working" would bury them. So a
 * row can legitimately show a solid unread dot while the cap declines to reclaim it.
 *
 * Every case pairs the busy result with the idle one on the SAME fixture — a rule expressed as a
 * post-hoc upgrade is otherwise satisfied by an implementation that ignores the flag entirely.
 */
describe('resolveLiveState — the agent reporting itself busy', () => {
  const finished = meta({ turnState: 'awaiting', turnEndedAt: AFTER, lastActivityAt: AFTER })

  it('breathes for a live session with nothing in its transcript', () => {
    // The case this exists for: work went into a subagent inside this session's process, so the
    // parent has written nothing and the row read as an idle terminal.
    expect(resolveLiveState(undefined, 0, false, false, SPAWN, null, true)).toBe('working')
    expect(resolveLiveState(undefined, 0, false, false, SPAWN, null, false)).toBe('quiet')
  })

  it('breathes for a finished turn the user has already seen', () => {
    // Seen, so nothing is being buried — and a subagent started after the visible turn ended is
    // exactly when this happens.
    expect(resolveLiveState(finished, AFTER, false, false, SPAWN, null, true)).toBe('working')
    expect(resolveLiveState(finished, AFTER, false, false, SPAWN, null, false)).toBe('quiet')
  })

  it('does not bury an unseen finished turn', () => {
    // The solid dot is the only signal that there is something to read. Busy must not outrank it.
    expect(resolveLiveState(finished, 0, false, false, SPAWN, null, true)).toBe('awaiting')
  })

  it('does not bury a manual mark-unread', () => {
    expect(resolveLiveState(finished, AFTER, false, true, SPAWN, null, true)).toBe('awaiting')
  })

  it('does not bury an unanswered question', () => {
    const asked = meta({ turnState: 'awaiting_input', lastActivityAt: AFTER })
    expect(resolveLiveState(asked, 0, false, false, SPAWN, null, true)).toBe('asking')
  })

  it('leaves a question the user is looking at quiet rather than breathing', () => {
    // The question branch returns `quiet` once you are looking at the prompt. A session waiting on
    // you must not start breathing just because the registry has not caught up — which is why the
    // upgrade is gated on there being no outstanding question, not merely on the result.
    const asked = meta({ turnState: 'awaiting_input', lastActivityAt: AFTER })
    expect(resolveLiveState(asked, 0, true, false, SPAWN, null, true)).toBe('quiet')
  })

  it('leaves a turn already in flight breathing, without double-counting it', () => {
    const working = meta({ turnState: 'in_progress', lastActivityAt: AFTER })
    expect(resolveLiveState(working, 0, false, false, SPAWN, null, true)).toBe('working')
  })
})

describe('resolveLiveState — runtime Codex input notifications', () => {
  const approvalAt = AFTER
  const codexWorking = meta({
    agent: 'codex',
    turnState: 'in_progress',
    lastActivityAt: SPAWN
  })

  it('pulses for an unseen OSC-only approval', () => {
    expect(resolveLiveState(codexWorking, 0, false, false, SPAWN, approvalAt)).toBe('asking')
  })

  it('clears immediately while the conversation is selected in the focused window', () => {
    expect(resolveLiveState(codexWorking, 0, true, false, SPAWN, approvalAt)).toBe('quiet')
  })

  it('stays clear after leaving once navigation recorded it as seen', () => {
    expect(resolveLiveState(codexWorking, approvalAt + 1, false, false, SPAWN, approvalAt)).toBe(
      'quiet'
    )
  })

  it('manual unread restores the approval pulse', () => {
    expect(
      resolveLiveState(codexWorking, approvalAt + 1, false, true, SPAWN, approvalAt)
    ).toBe('asking')
  })

  it('newer rollout activity supersedes a stale runtime approval', () => {
    const continued = meta({
      agent: 'codex',
      turnState: 'in_progress',
      lastActivityAt: approvalAt + 1
    })
    expect(resolveLiveState(continued, 0, false, false, SPAWN, approvalAt)).toBe('working')
  })

  it('turn completion supersedes a stale runtime approval', () => {
    const completed = meta({
      agent: 'codex',
      turnState: 'awaiting',
      turnEndedAt: approvalAt + 1,
      lastActivityAt: approvalAt + 1
    })
    expect(resolveLiveState(completed, 0, false, false, SPAWN, approvalAt)).toBe('awaiting')
  })

  it('keeps structured rollout questions authoritative without an OSC signal', () => {
    const question = meta({
      agent: 'codex',
      turnState: 'awaiting_input',
      lastActivityAt: approvalAt
    })
    expect(resolveLiveState(question, 0, false, false, SPAWN, null)).toBe('asking')
  })

  it('keeps a default-mode plain-English question as a completed unread turn', () => {
    const plainQuestion = meta({
      agent: 'codex',
      turnState: 'awaiting',
      turnEndedAt: approvalAt,
      lastActivityAt: approvalAt
    })
    expect(resolveLiveState(plainQuestion, 0, false, false, SPAWN, null)).toBe('awaiting')
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
