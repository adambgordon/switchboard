/**
 * Selecting several tabs at once, so one action can act on all of them.
 *
 * Three decisions shape everything here.
 *
 * **A selection lives in ONE pane.** Every group action has a direction or a destination — move right,
 * move left, close, drag — and a selection spanning both panes makes each of them ambiguous ("move
 * right" means what, for the tabs already on the right?). Clicking into the other pane therefore
 * starts a new selection rather than extending across.
 *
 * **Empty means "no multi-selection", not "nothing selected".** There is always an active tab, and
 * every action already knows how to act on it alone. Storing that as a one-element selection would
 * mean keeping this in step with every activation, every open, every close — a second copy of the
 * selection that could disagree with the first. So an empty set means "use the active tab", and this
 * only holds something once the user has deliberately built a group.
 *
 * **The anchor is a session id, not an index.** Tabs can be dragged while a selection exists, and an
 * index would then point at a different conversation than the one the user shift-clicked from.
 */

export interface TabSelection {
  /** Which pane the selection belongs to; -1 when there is none. */
  pane: number
  /** The selected conversations. Empty means no multi-selection is in effect. */
  ids: Set<string>
  /** What a ⇧-click extends from — the last tab plainly clicked or ⌘-clicked. */
  anchor: string | null
}

export const NO_SELECTION: TabSelection = { pane: -1, ids: new Set(), anchor: null }

/** Whether a group action should act on the selection rather than on a single tab. */
export function hasGroup(sel: TabSelection, pane: number): boolean {
  return sel.pane === pane && sel.ids.size > 1
}

/** The ids a command should act on: the group when there is one, else just the tab it was invoked on. */
export function actionTargets(sel: TabSelection, pane: number, sessionId: string): string[] {
  if (!hasGroup(sel, pane) || !sel.ids.has(sessionId)) return [sessionId]
  return [...sel.ids]
}

/** Keyboard close targets the focused group, even when its active tab was removed from that group. */
export function keyboardCloseTargets(sel: TabSelection, pane: number, activeId: string | null): string[] {
  if (hasGroup(sel, pane)) return [...sel.ids]
  return activeId ? [activeId] : []
}

/**
 * A plain click. Drops any group — this is the gesture that means "just this one", and it has to be
 * able to undo a selection that is in the way.
 */
export function selectOnly(): TabSelection {
  return NO_SELECTION
}

/** Whether a pointer press is outside the current group rather than another selection gesture. */
export function shouldClearSelectionOnPointerDown(
  sel: TabSelection,
  tabId: string | null,
  modifiedTabPress: boolean
): boolean {
  if (sel.ids.size === 0) return false
  if (tabId === null) return true
  if (modifiedTabPress) return false
  return !sel.ids.has(tabId)
}

export function shouldClearSelectionOnWindowBlur(
  sel: TabSelection,
  windowFocused: boolean
): boolean {
  return sel.ids.size > 0 && !windowFocused
}

/**
 * ⌘-click: add or remove one tab.
 *
 * Seeded with `activeId` when starting fresh, so ⌘-clicking a second tab selects BOTH — the active
 * one was already the implicit selection, and dropping it would make the gesture feel like it
 * deselected something.
 */
export function toggleSelected(
  sel: TabSelection,
  pane: number,
  activeId: string | null,
  sessionId: string
): TabSelection {
  const fresh = sel.pane !== pane || sel.ids.size === 0
  const ids = new Set(fresh ? (activeId && activeId !== sessionId ? [activeId] : []) : sel.ids)
  if (ids.has(sessionId)) {
    ids.delete(sessionId)
    // Removing the anchor leaves the next ⇧-click without an origin; fall back to any survivor rather
    // than silently doing nothing.
    const anchor = sel.anchor === sessionId ? ids.values().next().value ?? null : sel.anchor
    return ids.size === 0 ? NO_SELECTION : { pane, ids, anchor }
  }
  ids.add(sessionId)
  return { pane, ids, anchor: sessionId }
}

/**
 * ⇧-click: select the run between the anchor and this tab, inclusive.
 *
 * REPLACES the selection rather than adding to it, which is what every list of this kind does — it is
 * what makes a shift-click correctable by another shift-click, instead of only ever growing. The
 * anchor stays put for exactly that reason.
 *
 * `order` is the pane's tabs in display order.
 *
 * With no anchor yet, the ACTIVE tab is the anchor. That is what makes a first ⇧-click do something
 * worth doing instead of selecting the one tab you clicked, and it is what separates ⇧ from ⌘: ⇧ takes
 * the run from where you already are, ⌘ picks tabs off one at a time. Active on B, ⇧-click D ⇒ B, C, D.
 * Falls back to the clicked tab only when there is no active tab either — an empty pane, or one showing
 * the welcome screen.
 */
export function extendSelection(
  sel: TabSelection,
  pane: number,
  order: string[],
  sessionId: string,
  activeId?: string | null
): TabSelection {
  const to = order.indexOf(sessionId)
  if (to < 0) return sel
  const anchor = (sel.pane === pane ? sel.anchor : null) ?? activeId ?? null
  const from = anchor ? order.indexOf(anchor) : -1
  if (from < 0) return { pane, ids: new Set([sessionId]), anchor: sessionId }
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  return { pane, ids: new Set(order.slice(lo, hi + 1)), anchor }
}

/**
 * Drop anything the layout no longer holds.
 *
 * Tabs close, move between panes, and have their ids rewritten underneath a selection, and a stale
 * entry is not merely untidy: a group action would try to act on a conversation that is not there. Run
 * after every layout change rather than at each call site, so no path can forget.
 *
 * Returns the input by identity when nothing changed, so it can be applied unconditionally without
 * causing a render.
 */
export function pruneSelection(sel: TabSelection, paneOrder: string[][]): TabSelection {
  if (sel.ids.size === 0) return sel
  const order = paneOrder[sel.pane]
  if (!order) return NO_SELECTION
  const live = order.filter((id) => sel.ids.has(id))
  if (live.length === sel.ids.size) return sel
  if (live.length === 0) return NO_SELECTION
  // A survivor of one is deliberately KEPT rather than collapsed to nothing. It is no longer a group —
  // `hasGroup` says so, and nothing draws it as one — so collapsing would change only one thing: it
  // would throw the anchor away, and with it the ability to ⇧-click a new range from where the user
  // last was. A rule whose sole effect is to lose something is not a rule worth having.
  const ids = new Set(live)
  return { pane: sel.pane, ids, anchor: sel.anchor && ids.has(sel.anchor) ? sel.anchor : null }
}

/** Move a selected id across a bind, deduplicating when the real id was already in the group. */
export function retargetSelection(sel: TabSelection, from: string, to: string): TabSelection {
  if (from === to || !sel.ids.has(from)) return sel
  const ids = new Set(sel.ids)
  ids.delete(from)
  ids.add(to)
  return { ...sel, ids, anchor: sel.anchor === from ? to : sel.anchor }
}
