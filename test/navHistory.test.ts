import { describe, expect, it } from 'vitest'
import { navReducer, type NavAction, type NavState } from '../src/renderer/lib/useNavHistory'

const INITIAL: NavState = { selectedId: null, stack: [], cursor: -1 }

/** Apply a sequence of actions from INITIAL (or a given start) and return the final state. */
function run(actions: NavAction[], start: NavState = INITIAL): NavState {
  return actions.reduce(navReducer, start)
}

describe('navReducer', () => {
  it('open records a stop and selects it', () => {
    const s = run([{ type: 'open', id: 'a' }])
    expect(s).toEqual({ selectedId: 'a', stack: ['a'], cursor: 0 })
  })

  it('successive opens push stops and advance the cursor', () => {
    const s = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'b' },
      { type: 'open', id: 'c' }
    ])
    expect(s).toEqual({ selectedId: 'c', stack: ['a', 'b', 'c'], cursor: 2 })
  })

  it('re-opening the current stop does not duplicate it', () => {
    const s = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'a' }
    ])
    expect(s).toEqual({ selectedId: 'a', stack: ['a'], cursor: 0 })
  })

  it('back/forward walk the recorded stops', () => {
    const opened = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'b' },
      { type: 'open', id: 'c' }
    ])
    const back1 = navReducer(opened, { type: 'back' })
    expect(back1).toMatchObject({ selectedId: 'b', cursor: 1 })
    const back2 = navReducer(back1, { type: 'back' })
    expect(back2).toMatchObject({ selectedId: 'a', cursor: 0 })
    const fwd1 = navReducer(back2, { type: 'forward' })
    expect(fwd1).toMatchObject({ selectedId: 'b', cursor: 1 })
  })

  it('back is a no-op at the start, forward is a no-op at the newest stop', () => {
    const atStart = run([{ type: 'open', id: 'a' }])
    expect(navReducer(atStart, { type: 'back' })).toBe(atStart)
    expect(navReducer(atStart, { type: 'forward' })).toBe(atStart)
  })

  it('opening after going back truncates the forward history', () => {
    const s = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'b' },
      { type: 'open', id: 'c' },
      { type: 'back' }, // -> b (cursor 1), c still ahead
      { type: 'open', id: 'd' } // truncates c, pushes d
    ])
    expect(s).toEqual({ selectedId: 'd', stack: ['a', 'b', 'd'], cursor: 2 })
  })

  it('forward is inert while drifted (after home)', () => {
    const drifted = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'b' },
      { type: 'back' }, // -> a (cursor 0), b ahead
      { type: 'home' } // drift off stop a (selectedId null)
    ])
    expect(navReducer(drifted, { type: 'forward' })).toBe(drifted)
  })

  it('back/forward before anything is opened are no-ops', () => {
    expect(navReducer(INITIAL, { type: 'back' })).toBe(INITIAL)
    expect(navReducer(INITIAL, { type: 'forward' })).toBe(INITIAL)
  })

  it('home deselects (welcome screen) but leaves history intact', () => {
    const s = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'b' },
      { type: 'home' }
    ])
    expect(s).toEqual({ selectedId: null, stack: ['a', 'b'], cursor: 1 })
  })

  it('back after home re-centers on the last opened conversation', () => {
    const home = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'b' },
      { type: 'home' } // -> welcome (selectedId null); stack/cursor untouched
    ])
    const back1 = navReducer(home, { type: 'back' })
    expect(back1).toEqual({ selectedId: 'b', stack: ['a', 'b'], cursor: 1 })
    const back2 = navReducer(back1, { type: 'back' })
    expect(back2).toMatchObject({ selectedId: 'a', cursor: 0 })
  })

  it('home is a no-op when nothing is selected', () => {
    expect(navReducer(INITIAL, { type: 'home' })).toBe(INITIAL)
  })

  // rekey: a provisional new-Codex session's placeholder id is swapped for its real rollout id on
  // bind. It must update the selection AND every history stop so back/forward stay coherent.
  it('rekey swaps the placeholder id in both selection and stack', () => {
    const s = run([
      { type: 'open', id: 'a' },
      { type: 'open', id: 'P' },
      { type: 'rekey', from: 'P', to: 'real' }
    ])
    expect(s).toEqual({ selectedId: 'real', stack: ['a', 'real'], cursor: 1 })
  })

  it('rekey swaps a stack entry that is not the current selection', () => {
    const s = run([
      { type: 'open', id: 'P' },
      { type: 'open', id: 'b' },
      { type: 'rekey', from: 'P', to: 'real' }
    ])
    expect(s).toEqual({ selectedId: 'b', stack: ['real', 'b'], cursor: 1 })
  })

  it('rekey is a no-op when the id is absent', () => {
    const start = run([{ type: 'open', id: 'a' }])
    expect(navReducer(start, { type: 'rekey', from: 'missing', to: 'x' })).toBe(start)
  })

  it('rekey is a no-op when from === to', () => {
    const start = run([{ type: 'open', id: 'a' }])
    expect(navReducer(start, { type: 'rekey', from: 'a', to: 'a' })).toBe(start)
  })
})
