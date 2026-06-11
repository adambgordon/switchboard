import { useCallback, useReducer } from 'react'

/**
 * Browser-style back/forward navigation over conversation selection.
 *
 * Three kinds of move:
 *  - `open(id)`    — a *deliberate* open (click / Enter / resume / new / jump-to-live). Records
 *                    a history stop: truncates any forward entries, pushes, advances the cursor.
 *  - `preview(id)` — a transient selection (arrow keys). Moves the selection only; never touches
 *                    history. Selection can therefore *drift* off the current stop.
 *  - `home()`      — deselect entirely (back to the welcome screen). Like a preview-drift to
 *                    "nothing": history is left intact, so the next `back()` re-centers on the
 *                    last opened conversation.
 *
 * `back()` / `forward()` walk the recorded stops. If the selection has drifted (an arrow preview
 * moved it off the current stop), the first `back()` re-centers on that stop rather than skipping
 * past it; `forward()` is inert while drifted (nothing is recorded ahead of a drift).
 *
 * History is ephemeral session state — not persisted (like the Recent "Show more" reveal), so it
 * resets on reload, matching browser-session semantics.
 */
export interface NavState {
  selectedId: string | null
  /** Recorded stops, oldest first. */
  stack: string[]
  /** Index into `stack` of the current stop, or -1 when nothing has been opened yet. */
  cursor: number
}

export type NavAction =
  | { type: 'open'; id: string }
  | { type: 'preview'; id: string }
  | { type: 'home' }
  | { type: 'back' }
  | { type: 'forward' }

const INITIAL: NavState = { selectedId: null, stack: [], cursor: -1 }

/** Pure transition function — exported for unit testing (the hook itself isn't unit-tested). */
export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'preview':
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id }
    case 'home':
      // Deselect → the welcome screen. History is untouched (a drift to "nothing"), so the
      // next `back()` re-centers on the last opened conversation rather than skipping it.
      return state.selectedId === null ? state : { ...state, selectedId: null }
    case 'open': {
      // Re-opening the current stop only moves the selection — no duplicate entry.
      if (state.cursor >= 0 && state.stack[state.cursor] === action.id) {
        return state.selectedId === action.id ? state : { ...state, selectedId: action.id }
      }
      // Drop any forward history, then push the new stop (standard browser behavior).
      const stack = state.stack.slice(0, state.cursor + 1)
      stack.push(action.id)
      return { selectedId: action.id, stack, cursor: stack.length - 1 }
    }
    case 'back': {
      if (state.cursor < 0) return state
      // Drifted off the stop via an arrow preview → snap back to the stop first.
      if (state.selectedId !== state.stack[state.cursor]) {
        return { ...state, selectedId: state.stack[state.cursor] }
      }
      if (state.cursor === 0) return state
      return { ...state, cursor: state.cursor - 1, selectedId: state.stack[state.cursor - 1] }
    }
    case 'forward': {
      if (state.cursor < 0) return state
      // No redo target while drifted, or when already at the newest stop.
      if (state.selectedId !== state.stack[state.cursor]) return state
      if (state.cursor >= state.stack.length - 1) return state
      return { ...state, cursor: state.cursor + 1, selectedId: state.stack[state.cursor + 1] }
    }
    default:
      return state
  }
}

export function useNavHistory() {
  const [state, dispatch] = useReducer(navReducer, INITIAL)
  const open = useCallback((id: string) => dispatch({ type: 'open', id }), [])
  const preview = useCallback((id: string) => dispatch({ type: 'preview', id }), [])
  const home = useCallback(() => dispatch({ type: 'home' }), [])
  const back = useCallback(() => dispatch({ type: 'back' }), [])
  const forward = useCallback(() => dispatch({ type: 'forward' }), [])
  return { selectedId: state.selectedId, open, preview, home, back, forward }
}
