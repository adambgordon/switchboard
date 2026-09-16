import { describe, expect, it } from 'vitest'
import { resolveTurnActivity, type TurnSnapshot } from '../src/shared/turnActivity'

/**
 * The single derivation of what a session is doing, shared by the liveness dot and the
 * live-session cap. It exists because the raw `turnState` is wrong in two opposite directions, and
 * a consumer reading that field re-opens both:
 *
 *  - `in_progress` persists on a turn a PREVIOUS process abandoned, so a resumed interrupted
 *    session looks like live work forever;
 *  - `awaiting` is what the transcript says while a terminal holds a question the agent never
 *    wrote down, so a real unanswered prompt looks finished.
 *
 * Each case below pairs the raw field with the answer, so a regression to reading `turnState`
 * directly fails here rather than surfacing as a stopped session.
 */
describe('resolveTurnActivity', () => {
  const snap = (turnState: TurnSnapshot['turnState'], lastActivityAt: number | null): TurnSnapshot => ({
    turnState,
    lastActivityAt
  })

  it('reports a turn whose activity postdates the process as working', () => {
    expect(resolveTurnActivity(snap('in_progress', 5_000), 1_000, null)).toBe('working')
  })

  it('reports an in_progress turn abandoned by a previous process as idle', () => {
    // Quit mid-turn writes no interrupt sentinel, so the dangling turn survives; resuming spawns a
    // new process that replays history and sits idle. Raw `turnState` still says in_progress.
    expect(resolveTurnActivity(snap('in_progress', 1_000), 5_000, null)).toBe('idle')
  })

  it('treats a turn with no activity timestamp as working rather than guessing it is stale', () => {
    // Without a timestamp there is no evidence of a previous process, and calling live work idle is
    // the more expensive mistake.
    expect(resolveTurnActivity(snap('in_progress', null), 5_000, null)).toBe('working')
  })

  it('reports a finished turn as idle', () => {
    expect(resolveTurnActivity(snap('awaiting', 5_000), 1_000, null)).toBe('idle')
  })

  it('reports a structured transcript question as asking', () => {
    expect(resolveTurnActivity(snap('awaiting_input', 5_000), 1_000, null)).toBe('asking')
  })

  it('reports a runtime question raised AFTER the turn finished as asking', () => {
    // The case that makes this module load-bearing: an agent may open an approval or plan-mode
    // question only once the turn completes, and never persist it. `turnState` reads `awaiting`.
    expect(resolveTurnActivity(snap('awaiting', 5_000), 1_000, 6_000)).toBe('asking')
  })

  it('ignores a runtime question that newer transcript activity has superseded', () => {
    // Answered, or overtaken by a later turn — the notification is stale and must not pin the
    // session as asking forever.
    expect(resolveTurnActivity(snap('awaiting', 9_000), 1_000, 6_000)).toBe('idle')
  })

  it('reports a runtime question on a terminal with no transcript as asking', () => {
    // An unbound terminal can still raise a prompt. Resolving this to `unknown` would let the cap
    // discard an unanswered question, and `asking` is checked before the unknown gate for exactly
    // this reason.
    expect(resolveTurnActivity(undefined, 1_000, 6_000)).toBe('asking')
  })

  it('reports a terminal with no transcript at all as unknown, not idle', () => {
    // Distinct from idle on purpose: such a terminal may be mid-first-turn with its conversation
    // not yet observable, which the cap has to treat differently from a resting session.
    expect(resolveTurnActivity(undefined, 1_000, null)).toBe('unknown')
    expect(resolveTurnActivity(snap(undefined, 5_000), 1_000, null)).toBe('unknown')
  })

  it('does not demote a carryover when the row is not live', () => {
    // No spawn time means nothing to compare against, so the turn stands as written.
    expect(resolveTurnActivity(snap('in_progress', 1_000), null, null)).toBe('working')
  })
})
