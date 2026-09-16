import { describe, expect, it } from 'vitest'
import { chooseEvictionTargets, type EvictionCandidate } from '../src/main/pty/evictionPolicy'

/**
 * Which live PTYs the cap may stop. Extracted from PtyManager so the decision is reachable: it is
 * the only thing standing between reclaiming a forgotten terminal and killing work in flight, and
 * inside a private method on a stateful class no test could distinguish the two.
 *
 * Properties carrying the cases below. Only genuinely-in-flight work is protected outright — every
 * other difference is ORDER, because a rule that protects a terminal forever is a way to exceed the
 * cap without limit. Tiers rank by what is lost, not by age. Both inputs are transcript- or
 * use-derived rather than output-derived, because an agent TUI may repaint on a timer and would
 * otherwise look permanently active. And the caller is about to add one more, so "fits" means
 * fitting the newcomer too.
 *
 * `maxLive` here is deliberately never CONFIG.maxLivePtys: comparing against the same constant the
 * production caller passes cannot show that the parameter is honored rather than hardcoded.
 */
describe('chooseEvictionTargets', () => {
  /** A real conversation whose turn has finished — the ordinary evictable case. */
  const done = (ptyId: string, lastInputAt: number): EvictionCandidate => ({
    ptyId,
    lastInputAt,
    used: true,
    turnState: 'awaiting',
    onScreen: false
  })
  /** A terminal that was opened and never typed into. */
  const empty = (ptyId: string, openedAt: number): EvictionCandidate => ({
    ptyId,
    lastInputAt: openedAt,
    used: false,
    turnState: undefined,
    onScreen: false
  })
  const withState = (
    ptyId: string,
    lastInputAt: number,
    turnState: EvictionCandidate['turnState']
  ): EvictionCandidate => ({ ptyId, lastInputAt, used: true, turnState, onScreen: false })

  it('takes nothing while the newcomer still fits', () => {
    expect(chooseEvictionTargets([done('a', 100)], 3)).toEqual([])
  })

  it('takes one at the cap, because the caller is about to add another', () => {
    expect(chooseEvictionTargets([done('a', 100), done('b', 200)], 2)).toEqual(['a'])
  })

  it('takes as many as it needs when the set is already over the cap', () => {
    // Reachable by lowering the cap in Preferences, or by the set having been allowed to grow while
    // nothing was eligible. Freeing one slot per spawn would never converge from either.
    const live = [done('a', 100), done('b', 200), done('c', 300), done('d', 400), done('e', 500)]
    expect(chooseEvictionTargets(live, 3)).toEqual(['a', 'b', 'c'])
  })

  it('takes a terminal that is still emitting output but whose turn has finished', () => {
    // The case the previous output-based rule could never reach: an agent that repaints on a timer
    // keeps its PTY permanently "busy", so nothing about it ever looked idle.
    const live = [done('repainting', 100), withState('other', 200, 'in_progress')]
    expect(chooseEvictionTargets(live, 2)).toEqual(['repainting'])
  })

  it('takes an empty terminal before an older real conversation', () => {
    // Closing an empty terminal loses nothing; a finished conversation is something to return to.
    const live = [done('old-convo', 100), empty('newer-empty', 900)]
    expect(chooseEvictionTargets(live, 2)).toEqual(['newer-empty'])
  })

  it('exhausts every empty terminal before touching a real conversation', () => {
    const live = [done('convo', 100), empty('empty-new', 900), empty('empty-old', 500)]
    expect(chooseEvictionTargets(live, 2)).toEqual(['empty-old', 'empty-new'])
  })

  it('orders within a tier by last keystroke, not by position', () => {
    // Order the array so "oldest" and "first eligible" disagree, or a rule that takes the first
    // match passes without comparing anything.
    const live = [done('typed-recently', 900), done('untouched', 100)]
    expect(chooseEvictionTargets(live, 2)).toEqual(['untouched'])
  })

  it('never takes a session whose turn is in progress, even as the oldest', () => {
    const live = [withState('oldest-working', 100, 'in_progress'), done('newer-done', 900)]
    expect(chooseEvictionTargets(live, 2)).toEqual(['newer-done'])
  })

  it('never takes a session waiting on an answer from the user', () => {
    // The prompt lives in the terminal, so stopping it discards a question the user has not seen
    // answered. Protected for a different reason than in_progress.
    const live = [withState('asked-you', 100, 'awaiting_input'), done('newer-done', 900)]
    expect(chooseEvictionTargets(live, 2)).toEqual(['newer-done'])
  })

  it('takes a typed-into terminal with no known conversation LAST, but does take it', () => {
    // Possibly an unsent message, so it loses the most — but no rule may protect a terminal
    // forever, or the cap can be exceeded without limit by making terminals that satisfy it.
    // The fixture differs from `empty` only in `used`, which is the whole distinction asserted.
    const composing: EvictionCandidate = {
      ptyId: 'composing',
      lastInputAt: 100,
      used: true,
      turnState: undefined,
      onScreen: false
    }
    // Deferred while anything else is available, even something far more recent...
    expect(chooseEvictionTargets([composing, done('newer-done', 900)], 2)).toEqual(['newer-done'])
    // ...and taken once it is the only candidate.
    expect(chooseEvictionTargets([composing, withState('busy', 900, 'in_progress')], 2)).toEqual([
      'composing'
    ])
  })

  it('ranks all three tiers by what is lost, not by age', () => {
    // Ages run OPPOSITE to the intended order, so a rule that sorts by recency alone — or that
    // tiers on anything but what the terminal holds — produces a different answer.
    const live = [
      { ...empty('empty-newest', 900) },
      { ...done('convo-middle', 500) },
      {
        ptyId: 'unsent-oldest',
        lastInputAt: 100,
        used: true,
        turnState: undefined,
        onScreen: false
      } as EvictionCandidate
    ]
    expect(chooseEvictionTargets(live, 1)).toEqual(['empty-newest', 'convo-middle', 'unsent-oldest'])
  })

  it('cannot be made unreclaimable by typing into every terminal', () => {
    // The shape of the original bug, and of its first fix: any categorical protection is a way to
    // exceed the cap without limit. Every one of these has been typed into and has no conversation.
    const typedInto = [100, 200, 300, 400].map((at) => ({
      ptyId: `t${at}`,
      lastInputAt: at,
      used: true,
      turnState: undefined,
      onScreen: false
    }))
    expect(chooseEvictionTargets(typedInto, 2)).toEqual(['t100', 't200', 't300'])
  })

  it('never takes a terminal that is on screen, whatever its tier or age', () => {
    const live = [
      { ...empty('watched-empty', 10), onScreen: true },
      { ...done('watched-convo', 20), onScreen: true },
      done('offscreen', 900)
    ]
    expect(chooseEvictionTargets(live, 3)).toEqual(['offscreen'])
  })

  it('lets the set grow rather than interrupt work when nothing qualifies', () => {
    const live = [
      withState('a', 100, 'in_progress'),
      withState('b', 200, 'awaiting_input'),
      { ...done('c', 300), onScreen: true }
    ]
    expect(chooseEvictionTargets(live, 3)).toEqual([])
  })

  it('takes what it can when eligible sessions do not cover the shortfall', () => {
    // Partial progress beats refusing outright: the cap is still exceeded, but by less.
    const live = [withState('working', 100, 'in_progress'), done('done-a', 200), done('done-b', 300)]
    expect(chooseEvictionTargets(live, 1)).toEqual(['done-a', 'done-b'])
  })

  it('honors the cap it is given rather than a built-in default', () => {
    const live = [done('a', 100), done('b', 200)]
    expect(chooseEvictionTargets(live, 5)).toEqual([])
    expect(chooseEvictionTargets(live, 2)).toEqual(['a'])
  })

  it('takes nothing from an empty live set', () => {
    expect(chooseEvictionTargets([], 1)).toEqual([])
  })
})
