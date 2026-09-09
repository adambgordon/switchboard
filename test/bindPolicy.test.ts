import { describe, expect, it } from 'vitest'
import { bindActions, boundTabAdoption, type BindEvent } from '../src/renderer/lib/bindPolicy'
import { initialLayout, paneReducer } from '../src/renderer/lib/paneModel'

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
 *
 * The whole-object `toEqual` assertions below are deliberate rather than lazy: every session-keyed
 * store this policy has to reach is a field of the return, so adding a store without deciding what a
 * bind does to it breaks these tests instead of silently stranding its state under an id that will
 * never bind. Assert the whole object when adding one.
 */
describe('bindActions', () => {
  const initial = { oldId: 'placeholder', newId: 'S1', kind: 'initial' as const }
  const correction = { oldId: 'S1', newId: 'S2', kind: 'correction' as const }

  it('an initial bind migrates every piece of session-keyed state', () => {
    expect(bindActions(initial, 'placeholder', true)).toEqual({
      rekeySeen: true,
      view: 'move',
      retargetLiveOrder: true,
      focus: true,
      tabs: 'rekey',
      tabSelection: 'rekey'
    })
  })

  it('an initial bind migrates everything but focus regardless of what is selected', () => {
    // The placeholder is disappearing either way, so anything keyed to it must move or be orphaned.
    const away = bindActions(initial, 'something-else', true)
    const selected = bindActions(initial, 'placeholder', true)
    expect(away).toEqual({ ...selected, focus: false })
    expect(bindActions(initial, null, false)).toEqual({ ...selected, focus: false })
  })

  it('a correction never migrates persisted read state', () => {
    // The single most damaging mistake available here: `rekeySeen` writes through to localStorage,
    // so on a correction it would delete the old conversation's marker (it reappears unread) and
    // overwrite the new one's — and survive a restart.
    expect(bindActions(correction, 'S1', true).rekeySeen).toBe(false)
    expect(bindActions(correction, null, true).rekeySeen).toBe(false)
    expect(bindActions(correction, 'other', false).rekeySeen).toBe(false)
  })

  it('a correction follows the selection only when the user is on that terminal', () => {
    expect(bindActions(correction, 'S1', true)).toEqual({
      rekeySeen: false,
      view: 'copy',
      retargetLiveOrder: true,
      focus: true,
      tabs: 'retarget',
      tabSelection: 'retarget'
    })
    expect(bindActions(correction, 'other', true)).toEqual({
      rekeySeen: false,
      view: 'none',
      retargetLiveOrder: true,
      focus: false,
      tabs: 'none',
      tabSelection: 'none'
    })
  })

  it('a correction never steals focus or moves the view for a row nobody is looking at', () => {
    const away = bindActions(correction, null, true)
    expect(away.focus).toBe(false)
    expect(away.view).toBe('none')
  })

  it('both kinds keep the Live row in its slot', () => {
    // Rows are keyed by sessionId, so without this the same terminal reads as newly live and is
    // yanked to the top of Live. Initial binds are usually already at the top — but not if dragged.
    expect(bindActions(initial, null, false).retargetLiveOrder).toBe(true)
    expect(bindActions(correction, null, false).retargetLiveOrder).toBe(true)
  })

  it('tabs rekey globally on initial bind and retarget only with the selected owned terminal', () => {
    // A tab is session-keyed, so a bind has to reach it. `initial` rewrites every tab holding the
    // placeholder — it names nothing and is about to stop existing. `correction` retargets, because
    // an inactive tab on the old id is a view of a conversation that still exists.
    expect(bindActions(initial, 'placeholder', false).tabs).toBe('rekey')
    expect(bindActions(correction, 'S1', true).tabs).toBe('retarget')
    expect(bindActions(correction, 'other', true).tabs).toBe('none')
    expect(bindActions(correction, 'S1', false).tabs).toBe('none')
  })

  it('a non-owning window ignores a correction even when its transcript is selected', () => {
    expect(bindActions(correction, 'S1', false)).toEqual({
      rekeySeen: false,
      view: 'none',
      retargetLiveOrder: true,
      focus: false,
      tabs: 'none',
      tabSelection: 'none'
    })
  })

  it('a no-op event does nothing at all', () => {
    for (const kind of ['initial', 'correction'] as const) {
      expect(bindActions({ oldId: 'X', newId: 'X', kind }, 'X', true)).toEqual({
        rekeySeen: false,
        view: 'none',
        retargetLiveOrder: false,
        focus: false,
        tabs: 'none',
        tabSelection: 'none'
      })
    }
  })
})

describe('boundTabAdoption', () => {
  const initial: BindEvent = { oldId: 'PH', newId: 'S1', kind: 'initial' }

  it('waits for rekey, then commits an inactive initial tab without requiring focus', () => {
    let layout = paneReducer(initialLayout('p0'), {
      type: 'openMany', sessionIds: ['PH', 'B'], activeSessionId: 'B'
    })
    expect(boundTabAdoption(initial, layout)).toBe('wait')
    layout = paneReducer(layout, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(boundTabAdoption(initial, layout)).toBe('commit')
    expect(layout.panes[0].tabs.map((t) => t.sessionId)).toEqual(['S1', 'B'])
  })

  it('cancels when closure wins the race with initial rekey', () => {
    let layout = paneReducer(initialLayout('p0'), {
      type: 'openMany', sessionIds: ['PH', 'B'], activeSessionId: 'B'
    })
    layout = paneReducer(layout, { type: 'closeMany', sessionIds: ['PH'] })
    layout = paneReducer(layout, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(boundTabAdoption(initial, layout)).toBe('cancel')
    expect(layout.panes[0].tabs.map((t) => t.sessionId)).toEqual(['B'])
  })

  it('waits for placeholder removal even when the real tab already exists', () => {
    let layout = paneReducer(initialLayout('p0'), {
      type: 'openMany', sessionIds: ['PH', 'S1'], activeSessionId: 'PH'
    })
    expect(boundTabAdoption(initial, layout)).toBe('wait')
    layout = paneReducer(layout, { type: 'rekey', from: 'PH', to: 'S1' })
    expect(boundTabAdoption(initial, layout)).toBe('commit')
  })

  it('requires selection for correction, cancelling if navigation wins', () => {
    const correction: BindEvent = { oldId: 'S1', newId: 'S2', kind: 'correction' }
    let layout = paneReducer(initialLayout('p0'), {
      type: 'openMany', sessionIds: ['S1', 'S2', 'B'], activeSessionId: 'S1'
    })
    expect(boundTabAdoption(correction, layout)).toBe('wait')
    const retargeted = paneReducer(layout, { type: 'retarget', from: 'S1', to: 'S2' })
    expect(boundTabAdoption(correction, retargeted)).toBe('commit')
    layout = paneReducer(layout, { type: 'activate', pane: 0, index: 2 })
    expect(boundTabAdoption(correction, layout)).toBe('cancel')
  })
})
