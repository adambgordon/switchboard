import type { PtyBindKind } from '@shared/types'
import { activeTabId, locateTab, type PaneLayout } from './paneModel'

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
 * (the current stop must move with the selection, or Back/Forward drift — see the main navigation coordinator).
 *
 * See `PtyBindKind` for why the two cases are opposites and why the kind is told rather than
 * inferred.
 */
export interface BindEvent {
  oldId: string
  newId: string
  kind: PtyBindKind
}

export interface PendingBoundTab extends BindEvent {
  token: string
}

/** Read committed layout, not the intended dispatch: another action may have removed the tab. */
export function boundTabAdoption(
  claim: BindEvent,
  layout: PaneLayout
): 'wait' | 'commit' | 'cancel' {
  if (claim.kind === 'initial') {
    if (locateTab(layout, claim.oldId)) return 'wait'
    return locateTab(layout, claim.newId) ? 'commit' : 'cancel'
  }
  const selected = activeTabId(layout)
  if (selected === claim.newId) return 'commit'
  return selected === claim.oldId ? 'wait' : 'cancel'
}

export interface BindActions {
  /** Migrate persisted seen/unread markers old → new. NEVER on a correction: both ids are durable
   *  conversations, so this deletes one's read state and overwrites the other's. */
  rekeySeen: boolean
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
  /** Tabs are session-keyed too, so a bind has to reach them or a tab keeps naming an id that no
   *  longer means anything. `rekey` rewrites every tab holding the old id (right when it is a
   *  placeholder); `retarget` moves only the tab the user is standing on (right when the old id is a
   *  real conversation that still exists and other tabs on it are still correct). A correction is
   *  terminal-owned, so a transcript-only window never retargets its tab for another window's PTY. */
  tabs: 'rekey' | 'retarget' | 'none'
  /** Multi-selected tabs are terminal-owned for the member whose id changes. */
  tabSelection: 'rekey' | 'retarget' | 'none'
}

const INERT: BindActions = {
  rekeySeen: false,
  view: 'none',
  retargetLiveOrder: false,
  focus: false,
  tabs: 'none',
  tabSelection: 'none'
}

/**
 * Decide what one bind event must do. `selectedId` is the conversation the user is currently
 * looking at; `terminalOwnedHere` comes from main on the event itself, so a stale renderer snapshot
 * cannot make a transcript-only window follow another window's terminal.
 */
export function bindActions(
  ev: BindEvent,
  selectedId: string | null,
  terminalOwnedHere: boolean
): BindActions {
  if (ev.oldId === ev.newId) return INERT
  const selected = selectedId === ev.oldId
  if (ev.kind === 'initial') {
    // The old id is a throwaway placeholder naming no conversation, and it is about to stop
    // existing. Everything keyed to it has to come along or it is orphaned.
    return {
      rekeySeen: true,
      view: 'move',
      retargetLiveOrder: true,
      // Rekeying is global because the placeholder is disappearing, but a terminal that bound in
      // an unfocused pane must not take the keyboard from the pane the user moved to meanwhile.
      focus: selected,
      tabs: 'rekey',
      tabSelection: 'rekey'
    }
  }
  // A correction. Both ids name durable conversations: the old one drops back to Recent with its
  // own history and read state, and the new one may already carry its own. Nothing durable moves.
  const followsTerminal = terminalOwnedHere && selected
  return {
    rekeySeen: false,
    view: followsTerminal ? 'copy' : 'none',
    retargetLiveOrder: true,
    focus: followsTerminal,
    tabs: followsTerminal ? 'retarget' : 'none',
    tabSelection: followsTerminal ? 'retarget' : 'none'
  }
}
