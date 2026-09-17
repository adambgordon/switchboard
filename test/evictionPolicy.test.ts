import { describe, expect, it } from 'vitest'
import {
  RECENT_USE_GRACE_MS,
  STALE_REQUEST_MS,
  chooseEvictionTargets,
  type EvictionCandidate
} from '../src/main/pty/evictionPolicy'

/**
 * Which live PTYs the cap may stop. Extracted from PtyManager so the decision is reachable: it is
 * the only thing standing between reclaiming a forgotten terminal and killing work in flight, and
 * inside a private method on a stateful class no test could distinguish the two.
 *
 * Note what this suite deliberately does NOT model: how `activity` is arrived at. That resolution
 * — a carryover turn, a question the transcript never recorded — is one shared rule tested in
 * `turnActivity.test.ts`, and the wiring that feeds it is tested in `ptyEviction.test.ts`. The
 * policy is handed an answer; giving it raw transcript fields to re-interpret is the bug those two
 * suites exist to prevent.
 *
 * Only in-flight work is protected outright — every other difference is ORDER, because a rule that
 * protects a terminal forever is a way to exceed the cap without limit. Tiers rank by what is lost,
 * not by age. And the caller is about to add one more, so "fits" means fitting the newcomer too.
 *
 * `maxLive` is deliberately never CONFIG.maxLivePtys, and `NOW` never a value the implementation
 * holds: comparing against the same constant the production caller passes cannot show that a
 * parameter is honored rather than hardcoded.
 */
describe('chooseEvictionTargets', () => {
  const NOW = 10_000_000

  /** An idle conversation — the ordinary evictable case. */
  const idle = (ptyId: string, lastInputAt: number): EvictionCandidate => ({
    ptyId,
    lastInputAt,
    used: true,
    activity: 'idle',
    askedAt: null,
    onScreen: false
  })
  /** A terminal opened and never used, with nothing attributable to it. */
  const empty = (ptyId: string, openedAt: number): EvictionCandidate => ({
    ptyId,
    lastInputAt: openedAt,
    used: false,
    activity: 'unknown',
    askedAt: null,
    onScreen: false
  })
  /** Used, unattributable, and last touched long enough ago to be out of the grace window. */
  const unsent = (ptyId: string, lastInputAt: number): EvictionCandidate => ({
    ptyId,
    lastInputAt,
    used: true,
    activity: 'unknown',
    askedAt: null,
    onScreen: false
  })
  const doing = (
    ptyId: string,
    lastInputAt: number,
    activity: EvictionCandidate['activity'],
    now = NOW
  ): EvictionCandidate => ({
    ptyId,
    lastInputAt,
    used: true,
    activity,
    // Dated FRESH, not from `lastInputAt`, which these fixtures set to small numbers far behind
    // `NOW` — dating the question there would make every `asking` fixture stale and quietly assert
    // the opposite of what it reads as. Staleness and the undated case get their own tests.
    askedAt: activity === 'asking' ? now - 1_000 : null,
    onScreen: false
  })

  const choose = (live: EvictionCandidate[], maxLive: number, now = NOW): string[] =>
    chooseEvictionTargets(live, maxLive, now)

  it('takes nothing while the newcomer still fits', () => {
    expect(choose([idle('a', 100)], 3)).toEqual([])
  })

  it('takes one at the cap, because the caller is about to add another', () => {
    expect(choose([idle('a', 100), idle('b', 200)], 2)).toEqual(['a'])
  })

  it('takes as many as it needs when the set is already over the cap', () => {
    // Reachable by lowering the cap in Preferences, or by the set having grown while nothing was
    // eligible. Freeing one slot per spawn would never converge from either.
    const live = [idle('a', 100), idle('b', 200), idle('c', 300), idle('d', 400), idle('e', 500)]
    expect(choose(live, 3)).toEqual(['a', 'b', 'c'])
  })

  it('takes an idle terminal that is still emitting output', () => {
    // The case the previous output-based rule could never reach: an agent that repaints on a timer
    // keeps its PTY permanently "busy", so nothing about it ever looked idle. `activity` is resolved
    // from the transcript, so output cannot mask it.
    expect(choose([idle('repainting', 100), doing('other', 200, 'working')], 2)).toEqual([
      'repainting'
    ])
  })

  it('takes an empty terminal before an older idle conversation', () => {
    // Closing an empty terminal loses nothing; an idle conversation is something to return to.
    expect(choose([idle('old-convo', 100), empty('newer-empty', 900)], 2)).toEqual(['newer-empty'])
  })

  it('exhausts every empty terminal before touching a conversation', () => {
    const live = [idle('convo', 100), empty('empty-new', 900), empty('empty-old', 500)]
    expect(choose(live, 2)).toEqual(['empty-old', 'empty-new'])
  })

  it('orders within a tier by last use, not by position', () => {
    // Order the array so "oldest" and "first eligible" disagree, or a rule that takes the first
    // match passes without comparing anything.
    expect(choose([idle('used-recently', 900), idle('untouched', 100)], 2)).toEqual(['untouched'])
  })

  it('never takes a working session, even as the oldest', () => {
    expect(choose([doing('oldest-working', 100, 'working'), idle('newer', 900)], 2)).toEqual([
      'newer'
    ])
  })

  it('never takes a session waiting on an answer from the user', () => {
    // The prompt lives in the terminal, so stopping it discards a question. Protected for a
    // different reason than `working`, and reachable while the transcript reads as finished.
    expect(choose([doing('asked-you', 100, 'asking'), idle('newer', 900)], 2)).toEqual(['newer'])
  })

  it('ranks all three tiers by what is lost, not by age', () => {
    // Ages run OPPOSITE to the intended order, so a rule that sorts by recency alone — or that
    // tiers on anything but what the terminal holds — produces a different answer.
    const live = [empty('empty-newest', 900), idle('convo-middle', 500), unsent('unsent-oldest', 100)]
    expect(choose(live, 1)).toEqual(['empty-newest', 'convo-middle', 'unsent-oldest'])
  })

  it('takes an unattributable used terminal LAST, but does take it', () => {
    // Possibly an unsent message, so it loses the most — but no rule may protect a terminal
    // forever, or the cap can be exceeded without limit. The fixture differs from `empty` only in
    // `used`, which is the whole distinction being asserted.
    expect(choose([unsent('composing', 100), idle('newer', 900)], 2)).toEqual(['newer'])
    expect(choose([unsent('composing', 100), doing('busy', 900, 'working')], 2)).toEqual([
      'composing'
    ])
  })

  it('cannot be made unreclaimable by using every terminal', () => {
    // The shape of the original bug AND of its first attempted fix: any categorical protection is a
    // way to exceed the cap without limit.
    const used = [100, 200, 300, 400].map((at) => unsent(`t${at}`, at))
    expect(choose(used, 2)).toEqual(['t100', 't200', 't300'])
  })

  it('gives an unattributable used terminal no protection beyond the recent-use window', () => {
    // A longer grace lived here and was REMOVED. It was written for the seconds between submitting
    // a first turn and its conversation becoming attributable — which the recency guard below
    // already covers for every activity — but in practice it caught a terminal merely typed into
    // and never submitted, a state that never resolves, so a half-written line held a slot for as
    // long as the user kept touching it. Past the recency window it is reclaimable; its rank, not a
    // timer, is what keeps it safe.
    const typedLongAgo = unsent('draft', NOW - RECENT_USE_GRACE_MS)
    expect(choose([typedLongAgo, doing('busy', NOW, 'working')], 2)).toEqual(['draft'])
  })

  it('still takes a possible draft only as the last resort', () => {
    // The replacement for that grace. Ordered so age argues the other way: the draft is the OLDEST
    // candidate, so a rule that sorted by recency alone would take it first.
    const live = [unsent('draft', 100), idle('convo', 500), empty('never-used', 900)]
    expect(choose(live, 1)).toEqual(['never-used', 'convo', 'draft'])
  })

  it('never takes a session the user touched moments ago, whatever the transcript says', () => {
    // Submitting a turn does not update the index, so for a moment a session that has just been
    // given work still reads as idle. Recency of use is the only fact that is current here.
    const justSubmitted = idle('just-submitted', NOW - 1_000)
    expect(choose([justSubmitted, doing('busy', NOW, 'working')], 2)).toEqual([])
  })

  it('releases a recently used session once its window closes', () => {
    // Asserted from both sides of the boundary: a permanent protection and a long one cannot be
    // told apart from a single sample.
    const used = idle('aging', 0)
    const busy = doing('busy', NOW, 'working')
    expect(choose([used, busy], 2, RECENT_USE_GRACE_MS - 1)).toEqual([])
    expect(choose([used, busy], 2, RECENT_USE_GRACE_MS)).toEqual(['aging'])
  })

  it('does not extend the recent-use window to never-used terminals', () => {
    // An untouched terminal holds nothing however recently it was opened, so a burst of new
    // conversations must not become briefly unreclaimable.
    expect(choose([empty('fresh', NOW), doing('busy', NOW, 'working')], 2)).toEqual(['fresh'])
  })

  it('releases an abandoned question instead of protecting it for good', () => {
    // The bug this bound exists for: a Codex prompt is detected from output and cleared by nothing
    // if the user DECLINES it — accepting lets the transcript overtake it, declining leaves no trace
    // — so the terminal read as blocked on the user for as long as it lived. Asserted from both
    // sides, because a permanent veto and a long one look identical from one sample.
    const asked = { ...idle('asked', 100), activity: 'asking' as const, askedAt: 0 }
    const busy = doing('busy', NOW, 'working')
    expect(choose([asked, busy], 2, STALE_REQUEST_MS - 1)).toEqual([])
    expect(choose([asked, busy], 2, STALE_REQUEST_MS)).toEqual(['asked'])
  })

  it('ranks a lapsed question like the finished turn it sits on, not like an empty terminal', () => {
    // Lapsing removes the veto; it does not reclassify what the terminal holds. The transcript still
    // shows a conversation, so an empty terminal goes first — and this is what a mutation collapsing
    // the two would break.
    const asked = { ...idle('asked', 100), activity: 'asking' as const, askedAt: 0 }
    expect(choose([asked, empty('blank', 900)], 2, STALE_REQUEST_MS)).toEqual(['blank'])
  })

  it('does not protect a question it cannot date', () => {
    // `asking` with no timestamp cannot be aged, so protecting it would be protecting it forever.
    const undated = { ...idle('undated', 100), activity: 'asking' as const, askedAt: null }
    expect(choose([undated, doing('busy', NOW, 'working')], 2)).toEqual(['undated'])
  })

  it('ranks an undated question like a conversation, not like an empty terminal', () => {
    // Being unable to date a question says nothing about what the terminal HOLDS — there is still a
    // transcript behind it. Without this, dropping the undated case to tier 0 would take it ahead of
    // a genuinely empty terminal and no test would notice.
    const undated = { ...idle('undated', 100), activity: 'asking' as const, askedAt: null }
    expect(choose([undated, empty('blank', 900)], 2)).toEqual(['blank'])
  })

  it('protects a session Claude reports as working with nothing in its transcript', () => {
    // A subagent runs INSIDE the parent's process, and the parent may write no transcript for its
    // whole duration — so this arrives as `working` on a terminal that has nothing attributable to
    // it. Same fixture as `empty` but for the activity, which is the distinction being asserted.
    const subagent = { ...empty('subagent-host', 100), activity: 'working' as const }
    expect(choose([subagent, idle('convo', 900)], 2)).toEqual(['convo'])
  })

  it('never takes a terminal that is on screen, whatever its tier or age', () => {
    const live = [
      { ...empty('watched-empty', 10), onScreen: true },
      { ...idle('watched-convo', 20), onScreen: true },
      idle('offscreen', 900)
    ]
    expect(choose(live, 3)).toEqual(['offscreen'])
  })

  it('lets the set grow rather than interrupt work when nothing qualifies', () => {
    const live = [
      doing('a', 100, 'working'),
      doing('b', 200, 'asking'),
      { ...idle('c', 300), onScreen: true }
    ]
    expect(choose(live, 3)).toEqual([])
  })

  it('takes what it can when eligible sessions do not cover the shortfall', () => {
    // Partial progress beats refusing outright: the cap is still exceeded, but by less.
    const live = [doing('working', 100, 'working'), idle('done-a', 200), idle('done-b', 300)]
    expect(choose(live, 1)).toEqual(['done-a', 'done-b'])
  })

  it('honors the cap it is given rather than a built-in default', () => {
    const live = [idle('a', 100), idle('b', 200)]
    expect(choose(live, 5)).toEqual([])
    expect(choose(live, 2)).toEqual(['a'])
  })

  it('takes nothing from an empty live set', () => {
    expect(choose([], 1)).toEqual([])
  })
})
