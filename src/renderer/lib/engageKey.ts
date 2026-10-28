interface EngageKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
}

// The UI Events modifier keys. Pressed alone, one is the lead-in to a modified click — ⌥ to mark a
// conversation unread, ⇧ to pick a range of tabs — so it carries no input of its own.
const MODIFIER_KEYS = new Set([
  'Alt',
  'AltGraph',
  'CapsLock',
  'Control',
  'Fn',
  'FnLock',
  'Hyper',
  'Meta',
  'NumLock',
  'ScrollLock',
  'Shift',
  'Super',
  'Symbol',
  'SymbolLock'
])

/**
 * Whether a keydown in the pane body is the user engaging the open conversation, which clears its
 * manual unread mark. ⌘ and Ctrl chords are shortcuts (⇧⌘U is the one that sets the mark), and a
 * modifier on its own is only about to modify a click, so neither counts. A key typed WITH ⌥ or ⇧
 * held still does: that is input.
 */
export function isEngagingKey(e: EngageKey): boolean {
  return !e.metaKey && !e.ctrlKey && !MODIFIER_KEYS.has(e.key)
}
