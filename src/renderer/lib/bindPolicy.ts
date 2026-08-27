import type { PtyBindKind } from '@shared/types'

/**
 * What a `pty:bound` event must do to session-keyed renderer state.
 *
 * This lives outside the React effect on purpose. The decision it encodes — which state migrates
 * off the old id and which must be left alone — is the ONLY thing standing between a drift
 * correction and durable data loss: applying the placeholder migration to a correction deletes the
 * old conversation's persisted read marker, overwrites the new one's, and retargets history stops
 * that were genuine visits. Inside a hook that branch is unreachable by any test, and a one-line
 * regression to it looks exactly like working code. Pure, DOM-free, and mutation-checked instead.
 *
 * The split is CONVERSATION-owned state (persisted seen/unread, and EARLIER history stops — belongs
 * to the id) versus TERMINAL-owned state (the selection, the CURRENT history stop, the surface it
 * shows, the Live slot — describes the terminal, follows it). Two summaries to avoid, both too
 * strong: "a correction migrates nothing" (it migrates nothing *durable*) and "history never moves"
 * (the current stop must move with the selection, or Back/Forward drift — see navReducer.retarget).
 *
 * See `PtyBindKind` for why the two cases are opposites and why the kind is told rather than
 * inferred.
 */
export interface BindEvent {
  oldId: string
  newId: string
  kind: PtyBindKind
}

export interface BindActions {
  /** Migrate persisted seen/unread markers old → new. NEVER on a correction: both ids are durable
   *  conversations, so this deletes one's read state and overwrites the other's. */
  rekeySeen: boolean
  /** `rekey` rewrites every history stop (right when the old id is a placeholder that is ceasing to
   *  exist); `retarget` moves only the stop the user is standing on (right when earlier stops on the
   *  old id are genuine visits to a conversation that still exists). */
  nav: 'rekey' | 'retarget' | 'none'
  /** `move` transfers the remembered Formatted/Terminal surface and drops the old entry; `copy`
   *  carries it across while leaving the old conversation's own entry intact. */
  view: 'move' | 'copy' | 'none'
  /** Keep the Live row in its manual slot. The row's order key is its sessionId, so without this the
   *  order sync sees the old id vanish and the new one arrive, and treats the SAME terminal as newly
   *  live — yanking it to the top of Live and discarding a drag position. Applies to both kinds: on
   *  an initial bind the row is usually already at the top, but not if it was dragged first. */
  retargetLiveOrder: boolean
  /** Re-request focus so the terminal stays hot across the id change. */
  focus: boolean
}

const INERT: BindActions = {
  rekeySeen: false,
  nav: 'none',
  view: 'none',
  retargetLiveOrder: false,
  focus: false
}

/**
 * Decide what one bind event must do. `selectedId` is the conversation the user is currently
 * looking at, which only matters for a correction: the terminal itself is what moved, so the
 * selection follows it only when the user is actually on it.
 */
export function bindActions(ev: BindEvent, selectedId: string | null): BindActions {
  if (ev.oldId === ev.newId) return INERT
  if (ev.kind === 'initial') {
    // The old id is a throwaway placeholder naming no conversation, and it is about to stop
    // existing. Everything keyed to it has to come along or it is orphaned.
    return { rekeySeen: true, nav: 'rekey', view: 'move', retargetLiveOrder: true, focus: true }
  }
  // A correction. Both ids name durable conversations: the old one drops back to Recent with its
  // own history and read state, and the new one may already carry its own. Nothing durable moves.
  const selected = selectedId === ev.oldId
  return {
    rekeySeen: false,
    nav: 'retarget',
    view: selected ? 'copy' : 'none',
    retargetLiveOrder: true,
    focus: selected
  }
}
