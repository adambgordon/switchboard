import { describe, expect, it } from 'vitest'
import { tabPersistAction } from '../src/renderer/lib/tabPersistPolicy'

describe('tabPersistAction', () => {
  it('persists the layout while the preference is on', () => {
    expect(tabPersistAction(true, true)).toBe('persist')
  })

  it('persists as soon as the preference is switched on', () => {
    expect(tabPersistAction(false, true)).toBe('persist')
  })

  // The whole reason this decision is not "look at the current value": clearing belongs to the
  // ACT of switching off, not to the state of being off.
  it('clears the saved workspace when the preference is switched off', () => {
    expect(tabPersistAction(true, false)).toBe('clear')
  })

  // The regression this exists for. Every launch now starts with the preference off by default, so
  // treating "off" as "just switched off" deleted a saved layout on the first such launch — the
  // user loses tabs they never asked to lose, and no amount of turning the feature back on returns
  // them. `ignore` must be its own outcome: persisting here would overwrite the saved multi-tab
  // layout with the single preview tab the off-path holds, which loses the data just as surely.
  it('leaves the saved workspace untouched while the preference is simply off', () => {
    expect(tabPersistAction(false, false)).toBe('ignore')
  })

  it('never reports the same action for switching off as for staying off', () => {
    expect(tabPersistAction(true, false)).not.toBe(tabPersistAction(false, false))
  })
})
