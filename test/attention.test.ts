import { describe, expect, it } from 'vitest'
import { attentionAt, attentionOrder, bellState, type AttentionItem } from '../src/renderer/lib/attention'

const item = (sessionId: string, state: AttentionItem['state'], at: number): AttentionItem => ({ sessionId, state, at })
const ids = (items: AttentionItem[]): string[] => items.map((i) => i.sessionId)

describe('bellState', () => {
  it('pulses for a question anywhere, even behind unread ones', () => {
    expect(bellState(['awaiting', 'awaiting', 'asking'])).toBe('asking')
  })

  it('fills for unread turns alone', () => {
    expect(bellState(['awaiting'])).toBe('awaiting')
  })

  it('shows nothing when nothing needs you', () => {
    expect(bellState([])).toBeNull()
  })
})

describe('attentionOrder', () => {
  it('puts every question before every unread turn, however much newer the turn', () => {
    // The unread turn is the newest of all, so ordering by time alone would lead with it.
    const order = attentionOrder([item('u1', 'awaiting', 900), item('q1', 'asking', 100), item('q2', 'asking', 50)])
    expect(ids(order)).toEqual(['q1', 'q2', 'u1'])
  })

  it('newest first within each kind — not the rail order they arrived in', () => {
    const order = attentionOrder([
      item('q-old', 'asking', 10),
      item('u-old', 'awaiting', 20),
      item('q-new', 'asking', 30),
      item('u-new', 'awaiting', 40)
    ])
    expect(ids(order)).toEqual(['q-new', 'q-old', 'u-new', 'u-old'])
  })

  it('keeps rail order among those active in the same instant', () => {
    // Three ties, placed so that reversing them, or sorting by id, both give a different answer.
    const order = attentionOrder([item('b', 'awaiting', 5), item('c', 'awaiting', 5), item('a', 'awaiting', 5)])
    expect(ids(order)).toEqual(['b', 'c', 'a'])
  })
})


describe('attentionAt', () => {
  it('dates a question by its request, which can come after the last transcript write', () => {
    expect(attentionAt('asking', 100, 250)).toBe(250)
  })

  it('keeps the request time when the transcript was written to after it', () => {
    // Waiting on the answer, the agent may still log — the question was still asked at 250.
    expect(attentionAt('asking', 400, 250)).toBe(250)
  })

  it('falls back to the last write for a question with no recorded request', () => {
    expect(attentionAt('asking', 100, null)).toBe(100)
  })

  it('dates a finished turn by its last write, whatever an earlier request said', () => {
    expect(attentionAt('awaiting', 300, 250)).toBe(300)
  })
})
