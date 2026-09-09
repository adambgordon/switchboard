import { describe, expect, it } from 'vitest'
import { EMPTY_HISTORY, historyReducer, type HistoryAction } from '../src/main/navigationHistory'

const run = (actions: HistoryAction[]) => actions.reduce(historyReducer, EMPTY_HISTORY)
const visit = (sessionId: string, view: 'transcript' | 'terminal' = 'transcript'): HistoryAction =>
  ({ type: 'visit', visit: { sessionId, view } })

describe('app navigation history', () => {
  it('records visits and mode changes, collapsing only identical consecutive stops', () => {
    const state = run([visit('A'), visit('A'), visit('A', 'terminal'), visit('B'), visit('A')])
    expect(state).toEqual({
      entries: [
        { sessionId: 'A', view: 'transcript' }, { sessionId: 'A', view: 'terminal' },
        { sessionId: 'B', view: 'transcript' }, { sessionId: 'A', view: 'transcript' }
      ],
      cursor: 3, away: false
    })
  })

  it('walks backward and forward without changing the log', () => {
    const initial = run([visit('A'), visit('B', 'terminal'), visit('C')])
    const back = historyReducer(initial, { type: 'step', direction: -1 })
    expect(back.cursor).toBe(1)
    expect(back.entries).toBe(initial.entries)
    const forward = historyReducer(back, { type: 'step', direction: 1 })
    expect(forward).toEqual(initial)
  })

  it('clamps at the ends and remains inert before the first visit', () => {
    expect(historyReducer(EMPTY_HISTORY, { type: 'step', direction: -1 })).toBe(EMPTY_HISTORY)
    expect(historyReducer(EMPTY_HISTORY, { type: 'step', direction: 1 })).toBe(EMPTY_HISTORY)
    const one = run([visit('A')])
    expect(historyReducer(one, { type: 'step', direction: -1 })).toBe(one)
    expect(historyReducer(one, { type: 'step', direction: 1 })).toBe(one)
  })

  it('truncates Forward only when a new visit branches after Back', () => {
    const state = run([visit('A'), visit('B'), visit('C'), { type: 'step', direction: -1 }, visit('D')])
    expect(state.entries.map((v) => v.sessionId)).toEqual(['A', 'B', 'D'])
    expect(state.cursor).toBe(2)
  })

  it('leaves Forward intact when the current stop is re-reported', () => {
    const state = run([visit('A'), visit('B'), { type: 'step', direction: -1 }])
    expect(historyReducer(state, visit('A'))).toBe(state)
    expect(state.entries.map((v) => v.sessionId)).toEqual(['A', 'B'])
  })

  it('Welcome is a drift: Back re-centers, Forward waits, and no stop is added', () => {
    const state = run([visit('A'), visit('B'), { type: 'home' }])
    expect(state.entries.map((v) => v.sessionId)).toEqual(['A', 'B'])
    expect(state.away).toBe(true)
    expect(historyReducer(state, { type: 'home' })).toBe(state)
    expect(historyReducer(state, { type: 'step', direction: 1 })).toBe(state)
    const centered = historyReducer(state, { type: 'step', direction: -1 })
    expect(centered.cursor).toBe(1)
    expect(centered.away).toBe(false)
    expect(historyReducer(centered, { type: 'step', direction: -1 }).cursor).toBe(0)
  })

  it('rekeys every placeholder visit without losing mode or cursor', () => {
    const state = run([visit('PH'), visit('B'), visit('PH', 'terminal'), { type: 'rekey', from: 'PH', to: 'S' }])
    expect(state.entries).toEqual([
      { sessionId: 'S', view: 'transcript' }, { sessionId: 'B', view: 'transcript' },
      { sessionId: 'S', view: 'terminal' }
    ])
    expect(state.cursor).toBe(2)
  })

  it('corrections retarget only the current visit, keeping earlier conversation visits', () => {
    const state = run([visit('A'), visit('B'), visit('A', 'terminal'), { type: 'retarget', from: 'A', to: 'S' }])
    expect(state.entries).toEqual([
      { sessionId: 'A', view: 'transcript' }, { sessionId: 'B', view: 'transcript' },
      { sessionId: 'S', view: 'terminal' }
    ])
    expect(historyReducer(state, { type: 'retarget', from: 'A', to: 'X' })).toBe(state)
    const away = historyReducer(state, { type: 'home' })
    expect(historyReducer(away, { type: 'retarget', from: 'S', to: 'X' })).toBe(away)
  })

  it('ignores missing and same-id identity changes', () => {
    const state = run([visit('A')])
    expect(historyReducer(state, { type: 'rekey', from: 'absent', to: 'B' })).toBe(state)
    expect(historyReducer(state, { type: 'rekey', from: 'A', to: 'A' })).toBe(state)
    expect(historyReducer(state, { type: 'retarget', from: 'A', to: 'A' })).toBe(state)
  })
})
