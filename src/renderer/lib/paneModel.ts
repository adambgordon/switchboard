/**
 * Tabs and panes — the pure model behind the tab strip and the vertical split.
 *
 * One window holds one or two panes side by side; each pane holds an ordered list of tabs and
 * knows which is active. The **selection** — the conversation the app is showing and the keyboard
 * acts on — is derived, never stored twice: it is the active tab of the focused pane. Anything that
 * needs "the selected conversation" reads `activeTabId`.
 *
 * A tab is either **preview** or **persistent**. A preview tab is the one an ordinary click
 * replaces, so browsing a list of conversations doesn't accumulate tabs; a persistent tab holds its
 * slot until it is closed. A pane has at most one preview tab.
 *
 * Everything here is a pure function of state + action so the rules can be tested directly. Two
 * consequences worth keeping:
 *   - The reducer never generates an id. `split` is handed the new pane's id by its caller, because
 *     a reducer that reaches for a random source cannot be replayed in a test.
 *   - Pane ids must be unique for the life of the window, not merely among the panes alive right
 *     now: terminal ownership is keyed by pane id, so reusing an id after an unsplit would hand a
 *     new pane the previous occupant's terminals.
 */

/** A conversation occupying a slot in a pane. */
export interface Tab {
  sessionId: string
  /** Replaced in place by the next ordinary open, rather than pushing a new slot. */
  preview: boolean
}

export interface Pane {
  id: string
  tabs: Tab[]
  /**
   * Index into `tabs`, or -1 for "nothing active here".
   *
   * -1 is required when the pane is empty, and also **allowed while tabs are open**: that is the
   * welcome screen, reached by the Switchboard wordmark. Without that state the wordmark would become
   * a control that silently does nothing the moment a tab exists, and a click that closed the user's
   * tabs to get back to the welcome screen would be worse than either.
   */
  activeIndex: number
}

export interface PaneLayout {
  /** One pane, or two side by side. Vertical split only. */
  panes: Pane[]
  /** Which pane owns the keyboard. Always a valid index into `panes`. */
  focusIndex: number
  /** The left pane's share of the split. Only meaningful while two panes exist. */
  splitFraction: number
}

/** How an open should treat the tab it lands on. */
export type OpenMode = 'preview' | 'persistent'

export const SPLIT_LIMITS = { min: 0.2, default: 0.5, max: 0.8 } as const

export type PaneAction =
  /** Land on a conversation. The single entry point for every navigation. */
  | { type: 'open'; sessionId: string; mode: OpenMode; pane?: number; focus?: boolean }
  /** Make a preview tab stick (acting on the conversation, or an explicit gesture). */
  | { type: 'promote'; sessionId: string; pane?: number }
  | { type: 'close'; pane: number; index: number }
  | { type: 'closeOthers'; pane: number; index: number }
  | { type: 'activate'; pane: number; index: number }
  /** Show the welcome screen in the focused pane without disturbing its tabs. */
  | { type: 'deselect' }
  | { type: 'move'; from: { pane: number; index: number }; to: { pane: number; index: number } }
  /** Add the second pane. Its id is supplied because the reducer mints nothing. */
  | { type: 'split'; paneId: string }
  | { type: 'unsplit' }
  | { type: 'focusPane'; index: number }
  | { type: 'setSplitFraction'; value: number }
  /** A placeholder session id became real — the id named nothing, so every tab follows it. */
  | { type: 'rekey'; from: string; to: string }
  /** A live terminal turned out to be running a different, also-real conversation. */
  | { type: 'retarget'; from: string; to: string }
  /** Tabs were switched off: keep what is on screen, drop the rest. */
  | { type: 'collapseToSingle' }

export function initialLayout(paneId: string): PaneLayout {
  return {
    panes: [{ id: paneId, tabs: [], activeIndex: -1 }],
    focusIndex: 0,
    splitFraction: SPLIT_LIMITS.default
  }
}

// --- readers -------------------------------------------------------------------------------------

/** The active tab's session id in a pane, or null when the pane is empty. */
export function paneActiveId(pane: Pane): string | null {
  return pane.activeIndex >= 0 ? pane.tabs[pane.activeIndex]?.sessionId ?? null : null
}

/** The selection: the active tab of the focused pane. */
export function activeTabId(layout: PaneLayout): string | null {
  const pane = layout.panes[layout.focusIndex]
  return pane ? paneActiveId(pane) : null
}

/** Every conversation with a tab anywhere in the window. */
export function openSessionIds(layout: PaneLayout): Set<string> {
  const out = new Set<string>()
  for (const p of layout.panes) for (const t of p.tabs) out.add(t.sessionId)
  return out
}

/** Index of the tab for `sessionId` in `pane`, or -1. */
export function findTab(pane: Pane, sessionId: string): number {
  return pane.tabs.findIndex((t) => t.sessionId === sessionId)
}

/** Position of a conversation within a pane's tabs, searching panes left to right. */
export function locateTab(
  layout: PaneLayout,
  sessionId: string
): { pane: number; index: number } | null {
  for (let p = 0; p < layout.panes.length; p++) {
    const i = findTab(layout.panes[p], sessionId)
    if (i >= 0) return { pane: p, index: i }
  }
  return null
}

/**
 * Every tab in visual order — left pane's strip, then the right pane's. `⌥⌘←`/`→` walks this as one
 * line, so stepping off the end of the left pane's strip continues into the right pane's.
 */
export function tabSequence(layout: PaneLayout): { pane: number; index: number }[] {
  const out: { pane: number; index: number }[] = []
  for (let p = 0; p < layout.panes.length; p++) {
    for (let i = 0; i < layout.panes[p].tabs.length; i++) out.push({ pane: p, index: i })
  }
  return out
}

/**
 * The tab `delta` steps away from the current one, **wrapping** at both ends.
 *
 * Deliberately unlike the rail's `⌥⌘↑`/`↓`, which clamps: the rail is a long list where wrapping
 * from the last conversation to the first would be disorienting, whereas a strip holds a handful of
 * tabs and a next/previous that goes dead at an edge reads as broken. The two rules are independent
 * — do not infer either from the other.
 *
 * Returns null only when the window holds no tabs at all.
 */
export function stepTab(layout: PaneLayout, delta: number): { pane: number; index: number } | null {
  const seq = tabSequence(layout)
  if (seq.length === 0) return null
  const pane = layout.panes[layout.focusIndex]
  const current =
    pane && pane.activeIndex >= 0
      ? seq.findIndex((s) => s.pane === layout.focusIndex && s.index === pane.activeIndex)
      : -1
  // With nothing active (an empty focused pane) a forward step should land on the first tab and a
  // backward step on the last, so the chord still does something rather than silently no-opping.
  if (current < 0) return delta >= 0 ? seq[0] : seq[seq.length - 1]
  const next = (((current + delta) % seq.length) + seq.length) % seq.length
  return seq[next]
}

// --- internal helpers ----------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** Replace one pane, leaving every other field of the layout alone. */
function withPane(layout: PaneLayout, index: number, pane: Pane): PaneLayout {
  return { ...layout, panes: layout.panes.map((p, i) => (i === index ? pane : p)) }
}

/**
 * Resolve a caller-supplied pane index, falling back to the focused pane. An out-of-range index
 * resolves to the focused pane rather than throwing: callers hold indices across renders (a menu
 * that was opened before an unsplit, say), and a stale one should land somewhere sane.
 */
function resolvePane(layout: PaneLayout, index: number | undefined): number {
  if (index === undefined || index < 0 || index >= layout.panes.length) return layout.focusIndex
  return index
}

/**
 * Where the active tab lands after `removed` is taken out: the tab that slid into its slot, else
 * the new last one (so closing the rightmost tab selects its left neighbour).
 */
function activeAfterRemoval(activeIndex: number, removed: number, newLength: number): number {
  if (newLength === 0) return -1
  if (removed < activeIndex) return activeIndex - 1
  if (removed > activeIndex) return activeIndex
  return Math.min(removed, newLength - 1)
}

/**
 * Collapse an emptied pane in a split. A pane with no tabs has nothing to show, so it stops taking
 * up half the window; the survivor keeps its own tabs and takes the keyboard. The single remaining
 * pane is allowed to be empty — that is the welcome screen.
 */
function pruneEmptyPanes(layout: PaneLayout): PaneLayout {
  const keep = layout.panes.filter((p) => p.tabs.length > 0)
  if (keep.length === layout.panes.length) return layout
  // Nothing left anywhere — reachable, because `split` opens an empty pane, so closing the last tab
  // in the other one empties both. Keep exactly one pane so the window still has somewhere to render
  // the welcome state; a layout with no pane at all is not a representable state.
  //
  // There is deliberately no `panes.length < 2` fast path above this. It would be unobservable: the
  // equal-length early return already preserves identity for a single pane that still has tabs, and
  // this branch already returns the sole pane unchanged when it does not. A guard nothing can
  // distinguish reads like a rule without being one.
  if (keep.length === 0) {
    return { ...layout, panes: [layout.panes[layout.focusIndex]], focusIndex: 0 }
  }
  return { ...layout, panes: keep, focusIndex: 0 }
}

// --- reducer -------------------------------------------------------------------------------------

export function paneReducer(state: PaneLayout, action: PaneAction): PaneLayout {
  switch (action.type) {
    case 'open': {
      const target = resolvePane(state, action.pane)
      const pane = state.panes[target]
      const focus = action.focus !== false
      const existing = findTab(pane, action.sessionId)

      // Already open here: activate it rather than opening a second tab for one conversation. A
      // persistent open also makes it stick — clicking through to a preview tab and then acting on
      // it is the ordinary way a tab earns its place.
      if (existing >= 0) {
        const tabs =
          action.mode === 'persistent' && pane.tabs[existing].preview
            ? pane.tabs.map((t, i) => (i === existing ? { ...t, preview: false } : t))
            : pane.tabs
        const next = withPane(state, target, {
          ...pane,
          tabs,
          activeIndex: focus ? existing : pane.activeIndex
        })
        return focus ? { ...next, focusIndex: target } : next
      }

      if (action.mode === 'preview') {
        const previewIndex = pane.tabs.findIndex((t) => t.preview)
        if (previewIndex >= 0) {
          // Replace in place, holding the slot. This is what stops a walk through the list from
          // marching a tab rightwards across the strip.
          const tabs = pane.tabs.map((t, i) =>
            i === previewIndex ? { sessionId: action.sessionId, preview: true } : t
          )
          const next = withPane(state, target, {
            ...pane,
            tabs,
            activeIndex: focus ? previewIndex : pane.activeIndex
          })
          return focus ? { ...next, focusIndex: target } : next
        }
      }

      // Insert immediately after the active tab, so an opened conversation appears next to the one
      // it was opened from rather than at the far end of the strip. With nothing active — an empty
      // pane, or one showing the welcome screen — it goes at the end, which for an empty pane is
      // index 0 either way.
      const at = pane.activeIndex < 0 ? pane.tabs.length : pane.activeIndex + 1
      const tabs = [...pane.tabs]
      tabs.splice(at, 0, { sessionId: action.sessionId, preview: action.mode === 'preview' })
      // A background open (⌘+click) must not move the selection; the insert is after the active
      // tab, so the active index is unaffected either way.
      const next = withPane(state, target, {
        ...pane,
        tabs,
        activeIndex: focus ? at : pane.activeIndex
      })
      return focus ? { ...next, focusIndex: target } : next
    }

    case 'promote': {
      const target = resolvePane(state, action.pane)
      const pane = state.panes[target]
      const i = findTab(pane, action.sessionId)
      if (i < 0 || !pane.tabs[i].preview) return state
      return withPane(state, target, {
        ...pane,
        tabs: pane.tabs.map((t, k) => (k === i ? { ...t, preview: false } : t))
      })
    }

    case 'activate': {
      const pane = state.panes[action.pane]
      if (!pane || action.index < 0 || action.index >= pane.tabs.length) return state
      return {
        ...withPane(state, action.pane, { ...pane, activeIndex: action.index }),
        focusIndex: action.pane
      }
    }

    case 'deselect': {
      const pane = state.panes[state.focusIndex]
      if (!pane || pane.activeIndex === -1) return state
      return withPane(state, state.focusIndex, { ...pane, activeIndex: -1 })
    }

    case 'close': {
      const pane = state.panes[action.pane]
      if (!pane || action.index < 0 || action.index >= pane.tabs.length) return state
      const tabs = pane.tabs.filter((_, i) => i !== action.index)
      const withClosed = withPane(state, action.pane, {
        ...pane,
        tabs,
        activeIndex: activeAfterRemoval(pane.activeIndex, action.index, tabs.length)
      })
      return pruneEmptyPanes(withClosed)
    }

    case 'closeOthers': {
      const pane = state.panes[action.pane]
      if (!pane || action.index < 0 || action.index >= pane.tabs.length) return state
      return withPane(state, action.pane, {
        ...pane,
        tabs: [pane.tabs[action.index]],
        activeIndex: 0
      })
    }

    case 'move': {
      const src = state.panes[action.from.pane]
      const dstIndex = action.to.pane
      const dst = state.panes[dstIndex]
      if (!src || !dst) return state
      if (action.from.index < 0 || action.from.index >= src.tabs.length) return state
      const tab = src.tabs[action.from.index]

      if (action.from.pane === dstIndex) {
        // Reorder within one strip. The preview flag rides along: rearranging the strip is not a
        // statement about whether a tab should stick.
        const tabs = [...src.tabs]
        tabs.splice(action.from.index, 1)
        const at = clamp(action.to.index, 0, tabs.length)
        tabs.splice(at, 0, tab)
        const activeId = paneActiveId(src)
        return withPane(state, dstIndex, {
          ...src,
          tabs,
          activeIndex: activeId ? tabs.findIndex((t) => t.sessionId === activeId) : -1
        })
      }

      // Across panes. Deliberately promoting: a cross-pane move is an explicit placement, and a
      // preview tab arriving in a pane that already has one would break the one-preview rule.
      const moved: Tab = { ...tab, preview: false }
      const srcTabs = src.tabs.filter((_, i) => i !== action.from.index)
      const already = findTab(dst, tab.sessionId)
      const dstTabs = [...dst.tabs]
      let landed: number
      if (already >= 0) {
        // The destination already shows this conversation — activate what is there rather than
        // holding two tabs for it, and let the source lose its copy as the move asked.
        landed = already
      } else {
        landed = clamp(action.to.index, 0, dstTabs.length)
        dstTabs.splice(landed, 0, moved)
      }
      const panes = state.panes.map((p, i) => {
        if (i === action.from.pane) {
          // Plain removal from the source: `activeAfterRemoval` already keeps the same conversation
          // selected when a different tab left, and falls back to a neighbour when the active one did.
          return {
            ...p,
            tabs: srcTabs,
            activeIndex: activeAfterRemoval(src.activeIndex, action.from.index, srcTabs.length)
          }
        }
        // The destination's own preview tab is untouched: the arriving tab was promoted above, so
        // there is still at most one preview here. Demoting the resident tab would silently make a
        // pane the user was browsing in stop replacing its preview slot.
        if (i === dstIndex) return { ...p, tabs: dstTabs, activeIndex: landed }
        return p
      })
      return pruneEmptyPanes({ ...state, panes, focusIndex: dstIndex })
    }

    case 'split': {
      if (state.panes.length >= 2) return state
      return {
        ...state,
        panes: [...state.panes, { id: action.paneId, tabs: [], activeIndex: -1 }],
        focusIndex: 1
      }
    }

    case 'unsplit': {
      if (state.panes.length < 2) return state
      // What the user is looking at survives the merge as the active tab, whichever pane it was in.
      const keepId = activeTabId(state)
      const [left, right] = state.panes
      const tabs = [...left.tabs]
      const held = new Set(tabs.map((t) => t.sessionId))
      for (const t of right.tabs) {
        if (held.has(t.sessionId)) continue
        held.add(t.sessionId)
        // Incoming tabs are promoted: the survivor keeps its own preview slot, and two preview tabs
        // in one pane is not a representable state.
        tabs.push({ ...t, preview: false })
      }
      // `keepId` is always present in `tabs` when it is non-null — it came from one of the two panes,
      // and dedupe keeps the first occurrence rather than dropping it. Nothing selected stays nothing
      // selected: a merge is not a reason to pull the user off the welcome screen.
      const activeIndex = keepId === null ? -1 : tabs.findIndex((t) => t.sessionId === keepId)
      return { ...state, panes: [{ ...left, tabs, activeIndex }], focusIndex: 0 }
    }

    case 'focusPane': {
      if (action.index < 0 || action.index >= state.panes.length) return state
      if (action.index === state.focusIndex) return state
      return { ...state, focusIndex: action.index }
    }

    case 'setSplitFraction': {
      const value = clamp(action.value, SPLIT_LIMITS.min, SPLIT_LIMITS.max)
      if (value === state.splitFraction) return state
      return { ...state, splitFraction: value }
    }

    case 'rekey': {
      // A placeholder id was replaced by the real one it turned out to name. The placeholder named
      // no conversation, so every tab holding it follows — there is nothing left for it to mean.
      if (action.from === action.to) return state
      let touched = false
      const panes = state.panes.map((pane) => {
        const i = findTab(pane, action.from)
        if (i < 0) return pane
        touched = true
        const existing = findTab(pane, action.to)
        if (existing >= 0 && existing !== i) {
          // The real id is already open here; keep that tab and drop the placeholder's, rather than
          // leaving the pane with two tabs for one conversation. If the placeholder's tab was the
          // active one, the selection moves to the surviving tab — which is the same conversation,
          // now under the name it turned out to have.
          const tabs = pane.tabs.filter((_, k) => k !== i)
          const survivor = existing > i ? existing - 1 : existing
          return {
            ...pane,
            tabs,
            activeIndex:
              pane.activeIndex === i
                ? survivor
                : activeAfterRemoval(pane.activeIndex, i, tabs.length)
          }
        }
        return {
          ...pane,
          tabs: pane.tabs.map((t, k) => (k === i ? { ...t, sessionId: action.to } : t))
        }
      })
      return touched ? { ...state, panes } : state
    }

    case 'retarget': {
      // A live terminal is running a different conversation than the tab claims, and BOTH ids name
      // real conversations. Only the tab the user is actually standing on follows the terminal: an
      // inactive tab on the old id is a view of a conversation that still exists, and moving it
      // would relabel something the user never navigated. Mirrors the navigation history's rule.
      if (action.from === action.to) return state
      const target = state.focusIndex
      const pane = state.panes[target]
      if (!pane || paneActiveId(pane) !== action.from) return state
      const existing = findTab(pane, action.to)
      if (existing >= 0) {
        // Already open in this pane — show it, and leave the old tab alone. Its conversation did
        // not go anywhere; only the terminal moved.
        return withPane(state, target, { ...pane, activeIndex: existing })
      }
      return withPane(state, target, {
        ...pane,
        tabs: pane.tabs.map((t, k) =>
          k === pane.activeIndex ? { ...t, sessionId: action.to } : t
        )
      })
    }

    case 'collapseToSingle': {
      // Tabs were switched off. Keep exactly what is on screen and discard the rest, landing in the
      // shape the feature-off path expects: one pane, one preview tab that the next open replaces.
      const keepId = activeTabId(state)
      const pane = state.panes[state.focusIndex]
      return {
        ...state,
        panes: [
          {
            id: pane.id,
            tabs: keepId === null ? [] : [{ sessionId: keepId, preview: true }],
            activeIndex: keepId === null ? -1 : 0
          }
        ],
        focusIndex: 0
      }
    }

    default:
      return state
  }
}
