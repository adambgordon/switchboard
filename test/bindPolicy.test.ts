import { describe, expect, it } from 'vitest'
import { bindActions } from '../src/renderer/lib/bindPolicy'

/**
 * The renderer's `pty:bound` policy. Extracted from App's effect precisely so it can be tested: the
 * branch that separates an initial bind from a drift correction is the only thing preventing a
 * correction from deleting one real conversation's persisted read marker and overwriting another's,
 * and left inside the hook no test could reach it.
 *
 * The asymmetry under test: `initial` migrates everything off a placeholder that is ceasing to exist;
 * `correction` migrates no CONVERSATION-owned state — persisted seen/unread markers and earlier
 * history stops stay with the id that owns them, because both ids name conversations that continue to
 * exist. Terminal-owned state still follows the terminal: the selection, the current history stop,
 * the surface it is showing, and the row's Live slot.
 */
describe('bindActions', () => {
  const initial = { oldId: 'placeholder', newId: 'S1', kind: 'initial' as const }
  const correction = { oldId: 'S1', newId: 'S2', kind: 'correction' as const }

  it('an initial bind migrates every piece of session-keyed state', () => {
    expect(bindActions(initial, 'placeholder')).toEqual({
      rekeySeen: true,
      nav: 'rekey',
      view: 'move',
      retargetLiveOrder: true,
      focus: true
    })
  })

  it('an initial bind migrates regardless of what is selected', () => {
    // The placeholder is disappearing either way, so anything keyed to it must move or be orphaned.
    expect(bindActions(initial, 'something-else')).toEqual(bindActions(initial, 'placeholder'))
    expect(bindActions(initial, null)).toEqual(bindActions(initial, 'placeholder'))
  })

  it('a correction never migrates persisted read state', () => {
    // The single most damaging mistake available here: `rekeySeen` writes through to localStorage,
    // so on a correction it would delete the old conversation's marker (it reappears unread) and
    // overwrite the new one's — and survive a restart.
    expect(bindActions(correction, 'S1').rekeySeen).toBe(false)
    expect(bindActions(correction, null).rekeySeen).toBe(false)
    expect(bindActions(correction, 'other').rekeySeen).toBe(false)
  })

  it('a correction retargets navigation rather than rewriting it', () => {
    // `rekey` would rewrite earlier stops on the old id, which were genuine visits to a conversation
    // that still exists once the terminal leaves it.
    expect(bindActions(correction, 'S1').nav).toBe('retarget')
    expect(bindActions(correction, 'other').nav).toBe('retarget')
  })

  it('a correction follows the selection only when the user is on that terminal', () => {
    expect(bindActions(correction, 'S1')).toEqual({
      rekeySeen: false,
      nav: 'retarget',
      view: 'copy',
      retargetLiveOrder: true,
      focus: true
    })
    expect(bindActions(correction, 'other')).toEqual({
      rekeySeen: false,
      nav: 'retarget',
      view: 'none',
      retargetLiveOrder: true,
      focus: false
    })
  })

  it('a correction never steals focus or moves the view for a row nobody is looking at', () => {
    const away = bindActions(correction, null)
    expect(away.focus).toBe(false)
    expect(away.view).toBe('none')
  })

  it('both kinds keep the Live row in its slot', () => {
    // Rows are keyed by sessionId, so without this the same terminal reads as newly live and is
    // yanked to the top of Live. Initial binds are usually already at the top — but not if dragged.
    expect(bindActions(initial, null).retargetLiveOrder).toBe(true)
    expect(bindActions(correction, null).retargetLiveOrder).toBe(true)
  })

  it('a no-op event does nothing at all', () => {
    for (const kind of ['initial', 'correction'] as const) {
      expect(bindActions({ oldId: 'X', newId: 'X', kind }, 'X')).toEqual({
        rekeySeen: false,
        nav: 'none',
        view: 'none',
        retargetLiveOrder: false,
        focus: false
      })
    }
  })
})
