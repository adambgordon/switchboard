import { describe, expect, it } from 'vitest'
import {
  canPersistTabWorkspace,
  restoredWorkspaceApplied,
  tabPersistAction
} from '../src/renderer/lib/tabPersistPolicy'

describe('tabPersistAction', () => {
  it('persists the layout while the preference is on', () => {
    expect(tabPersistAction(true, true)).toBe('persist')
  })

  it('activates a dormant workspace when the preference is switched on', () => {
    expect(tabPersistAction(false, true)).toBe('activate')
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

describe('workspace activation guards', () => {
  it('persists only after an enabled workspace is ready', () => {
    expect(canPersistTabWorkspace(false, false)).toBe(false)
    expect(canPersistTabWorkspace(false, true)).toBe(false)
    expect(canPersistTabWorkspace(true, false)).toBe(false)
    expect(canPersistTabWorkspace(true, true)).toBe(true)
  })

  it('completes activation only when the saved layout reached the reducer', () => {
    expect(restoredWorkspaceApplied(null, 'saved')).toBe(false)
    expect(restoredWorkspaceApplied('saved', 'temporary')).toBe(false)
    expect(restoredWorkspaceApplied('saved', 'saved')).toBe(true)
  })
})
