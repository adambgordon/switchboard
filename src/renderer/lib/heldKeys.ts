/**
 * Which modifier keys are held — for controls whose meaning changes under one: ⌥ turns a running
 * tab's × into stop-and-close, ⇧ sends a new conversation to a new window.
 *
 * Deliberately NOT React state. ⇧ goes down with every capital letter typed into a terminal, and
 * state would re-render each control listening for it on every one of those keystrokes. So what shows
 * the change is outside React: CSS reads `data-alt-held` on the root (the red ×),
 * and the tooltip layer, which is subscribed here, swaps in a host's `data-tip-alt` / `data-tip-shift`
 * text. A click reads its own event's `altKey` / `shiftKey`, so nothing needs this to act.
 *
 * Any key or pointer event carries the full modifier state, so each one corrects it; losing focus
 * clears it, since a key released in another app never reaches this one.
 */
export interface HeldKeys {
  alt: boolean
  shift: boolean
}

let held: HeldKeys = { alt: false, shift: false }
const listeners = new Set<(keys: HeldKeys) => void>()
let installed = false

function set(next: HeldKeys): void {
  if (next.alt === held.alt && next.shift === held.shift) return
  held = next
  const root = document.documentElement
  root.toggleAttribute('data-alt-held', next.alt)
  for (const l of listeners) l(next)
}

function install(): void {
  if (installed) return
  installed = true
  const fromEvent = (e: KeyboardEvent | MouseEvent): void => set({ alt: e.altKey, shift: e.shiftKey })
  window.addEventListener('keydown', fromEvent, true)
  window.addEventListener('keyup', fromEvent, true)
  window.addEventListener('mousemove', fromEvent, true)
  window.addEventListener('mousedown', fromEvent, true)
  window.addEventListener('blur', () => set({ alt: false, shift: false }))
}

export function heldKeys(): HeldKeys {
  return held
}

/** Follow changes to the held modifiers. Returns an unsubscribe. */
export function onHeldKeys(listener: (keys: HeldKeys) => void): () => void {
  install()
  listeners.add(listener)
  return () => listeners.delete(listener)
}
