import { describe, expect, it } from 'vitest'
import { shouldResync } from '../src/renderer/lib/storageSync'

describe('shouldResync', () => {
  it('re-reads when this key changed in another window', () => {
    expect(shouldResync('switchboard.tabs', 'switchboard.tabs')).toBe(true)
  })

  // `localStorage.clear()` reports a null key — nothing single changed, everything did. Treating it
  // as "not mine" leaves this window rendering preferences that no longer exist on disk.
  it('re-reads when another window cleared the whole store', () => {
    expect(shouldResync(null, 'switchboard.tabs')).toBe(true)
  })

  // The counterweight: every open window listens for every preference. Without this, one unrelated
  // write re-reads and re-renders each of them.
  it('ignores an unrelated key so one write does not wake every hook', () => {
    expect(shouldResync('switchboard.pins', 'switchboard.tabs')).toBe(false)
  })

  // A prefix must not count as a match — these keys are a flat namespace, not a hierarchy.
  it('ignores a key that merely shares a prefix', () => {
    expect(shouldResync('switchboard.tabs.extra', 'switchboard.tabs')).toBe(false)
    expect(shouldResync('switchboard.tab', 'switchboard.tabs')).toBe(false)
  })
})
