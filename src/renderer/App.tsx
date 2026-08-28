import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type { AgentKind, ConversationMeta, LiveState, PtyState } from '@shared/types'
import { useSessions } from './lib/useSessions'
import { usePtys } from './lib/usePtys'
import { usePins } from './lib/usePins'
import { useLiveOrder } from './lib/useLiveOrder'
import { bindActions } from './lib/bindPolicy'
import { useLayout } from './lib/useLayout'
import { usePaneLayout } from './lib/usePaneLayout'
import { useTabsEnabled } from './lib/useTabsEnabled'
import {
  SPLIT_LIMITS,
  locateTab,
  openSessionIds,
  paneActiveId,
  stepTab,
  type OpenMode
} from './lib/paneModel'
import {
  NO_SELECTION,
  actionTargets,
  extendSelection,
  pruneSelection,
  selectOnly,
  toggleSelected,
  type TabSelection
} from './lib/tabSelection'
import { nextPtyHomes, partitionPtys } from './lib/ptyHome'
import { useMarkdownCopy } from './lib/useMarkdownCopy'
import { useNewConvoDefault } from './lib/useNewConvoDefault'
import { useNewConvoDefaultAgent } from './lib/useNewConvoDefaultAgent'
import { useAgentAvailability } from './lib/useAgentAvailability'
import { useMaxLiveSessions } from './lib/useMaxLiveSessions'
import { useSeen } from './lib/useSeen'
import { useWindowFocus } from './lib/useWindowFocus'
import { useTranscript } from './lib/useTranscript'
import { useNavHistory } from './lib/useNavHistory'
import { useTheme } from './lib/useTheme'
import { useDarkIcon } from './lib/useDarkIcon'
import { useUpdates } from './lib/useUpdates'
import { searchConversations } from './lib/fuzzy'
import { basename } from './lib/format'
import { initPtyStream, retainOnly } from './lib/ptyStream'
import { currentInputRequestedAt } from './lib/liveness'
import {
  displayTitleForRow,
  isParkedOnlyRow,
  isUnlinkedRow,
  liveDotClass,
  resolveRowLiveState
} from './lib/rowIdentity'
import TitleBar from './components/TitleBar'
import MainPane from './components/MainPane'
import type { TabDescriptor } from './components/TabStrip'
import TallyRail, { visibleEntries, type RailEntry, type RailSection } from './components/TallyRail'
import ResizeHandle from './components/ResizeHandle'
import SettingsModal from './components/SettingsModal'
import CapWarningModal from './components/CapWarningModal'
import ConversationInfoModal from './components/ConversationInfoModal'
import TooltipLayer from './components/TooltipLayer'
import AppVeil from './components/AppVeil'

type View = 'transcript' | 'terminal'

/** Recent section: rows shown in 'recent' mode before toggling to 'all'. */
const RECENT_CAP = 30

/** Display-only meta for a live session the index hasn't caught yet (no preview until its JSONL is written). */
function synthMeta(p: PtyState): ConversationMeta {
  return {
    sessionId: p.sessionId,
    agent: p.agent,
    cwd: p.cwd,
    title: p.title,
    preview: '',
    gitBranch: null,
    mtime: p.lastActivity,
    messageCount: 0,
    version: null,
    sizeBytes: 0,
    model: null,
    outputTokens: 0,
    inputTokens: 0,
    inputBaseTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    contextTokens: 0,
    firstActivityAt: null,
    provisional: true
  }
}

export default function App() {
  const { groups, loading } = useSessions()
  const ptys = usePtys()
  const { pinned, order: pinnedOrder, toggle: togglePin, reorder: reorderPins } = usePins()
  // A nonce bumped on each drag-reorder commit, folded into the rail's FLIP controlSig so the commit
  // settles instantly (the drag already showed the arrangement); pin/unpin toggles don't bump it, so
  // they still glide.
  const [reorderTick, setReorderTick] = useState(0)
  const commitReorder = useCallback(
    (from: number, to: number) => {
      reorderPins(from, to)
      setReorderTick((t) => t + 1)
    },
    [reorderPins]
  )
  // The Live section's manual order — ephemeral (live PTYs don't outlive the app). Like the pinned
  // order it makes Live rows drag-reorderable AND immune to any activity-driven re-sort: a row holds
  // its slot until you drag it. Every newly-live session (new or resumed) lands on top.
  const liveUnpinnedIds = useMemo(
    () => ptys.active.filter((p) => !pinned.has(p.sessionId)).map((p) => p.sessionId),
    [ptys.active, pinned]
  )
  const {
    order: liveOrder,
    reorder: reorderLive,
    retarget: retargetLiveOrder
  } = useLiveOrder(liveUnpinnedIds)
  const commitLiveReorder = useCallback(
    (from: number, to: number) => {
      reorderLive(from, to)
      setReorderTick((t) => t + 1)
    },
    [reorderLive]
  )
  const { seen, unread, markUnread, markRead, rekey: rekeySeen } = useSeen()
  const { dir: defaultDir, setDir: setDefaultDir } = useNewConvoDefault()
  const { enabled: markdownCopy, setEnabled: setMarkdownCopy } = useMarkdownCopy()
  const {
    agent: defaultAgent,
    enabled: defaultAgentEnabled,
    setAgent: setDefaultAgent,
    setEnabled: setDefaultAgentEnabled
  } = useNewConvoDefaultAgent()
  const agents = useAgentAvailability()
  // The agent the New menu shows selected — sticky within a session (the last one picked or started),
  // so reopening the menu remembers your choice. Ephemeral on purpose: the persisted default-agent
  // preference is the cross-restart mechanism; this is just menu stickiness.
  const [lastAgent, setLastAgent] = useState<AgentKind | null>(null)
  const {
    value: maxLive,
    min: maxLiveMin,
    max: maxLiveMax,
    defaultValue: maxLiveDefault,
    set: setMaxLive,
    reset: resetMaxLive
  } = useMaxLiveSessions()
  const { mode: themeMode, resolved: themeResolved, setMode: setThemeMode, toggle: toggleTheme } = useTheme()
  const darkIcon = useDarkIcon()
  const updates = useUpdates()
  const focused = useWindowFocus()
  // A window opened to show one conversation. It is the same app with the rail hidden — ⌘B brings the
  // browser back — rather than a second, cut-down shell. `persist: false` is load-bearing: layout
  // lives in localStorage, which every window of the app shares, so a detached window writing its
  // collapsed rail there would hand that state to the browser window on the next launch.
  // Optional-chained on purpose: editing the preload does not hot-reload, so a dev instance that was
  // already running when this was added would otherwise throw here and white-screen the whole app
  // rather than simply behaving like an ordinary window.
  const windowInit = window.sbWindow ?? { sessionIds: [], collapseRail: false }
  const detached = windowInit.sessionIds.length > 0
  const {
    paneWidth,
    paneCollapsed,
    sections: collapsedSections,
    setPaneWidth,
    togglePane,
    resetPane,
    toggleSection
  } = useLayout({ collapseRail: windowInit.collapseRail, persist: !detached })
  const dragStartRef = useRef(0)
  // The split divider reports a pointer delta, so a drag needs the fraction it began at AND the
  // container width that delta is a fraction of.
  const panesElRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<{ fraction: number; width: number }>({
    fraction: SPLIT_LIMITS.default,
    width: 0
  })

  // Tabs / split / detached windows, all behind one preference. OFF is a degenerate case of the SAME
  // model — one pane holding one preview tab, so every open replaces it — which is what the app did
  // before tabs existed. So the flag gates only the strip's presence, the promotion gestures, and the
  // split / window commands; nothing below asks about it. See useTabsEnabled.
  const { enabled: tabsEnabled, setEnabled: setTabsEnabled } = useTabsEnabled()
  const panes = usePaneLayout()
  const { layout: paneLayout } = panes
  // THE selection: the active tab of the focused pane. Derived, never stored twice.
  const selectedId = panes.selectedId

  const {
    selectedId: navSelectedId,
    open,
    home,
    back,
    forward,
    rekey: rekeyNav,
    retarget: retargetNav
  } = useNavHistory()
  // Read by the onPtyBound listener, which must not re-subscribe on every selection change.
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  // Session-targeted focus request, bumped whenever you land on a conversation (a click, ⌥⌘↑/↓
  // switch, Enter, resume, new, go-live) — the main pane always takes the keyboard. A per-session
  // focusReq lets MainPane route focus to the right surface (a live terminal, else the Formatted
  // transcript) only for the selected conversation.
  const [focusReq, setFocusReq] = useState<{ sessionId: string; n: number } | null>(null)
  const requestFocus = useCallback(
    (sessionId: string) => setFocusReq((r) => ({ sessionId, n: (r?.n ?? 0) + 1 })),
    []
  )
  // Per-conversation view memory (Formatted vs Terminal). The choice sticks per
  // session, so leaving and returning to a live conversation restores its view.
  const [viewBySession, setViewBySession] = useState<Record<string, View>>({})
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<
    'appearance' | 'application' | 'shortcuts' | 'faq' | null
  >(null)
  // Conversation-info modal target: which session, and whether to open straight into title-edit vs
  // view (both the pane title and the right-click "Session details…" open in view). Null when closed.
  const [infoModal, setInfoModal] = useState<{ sessionId: string; edit: boolean } | null>(null)
  // Section keys revealed past their cap via "Show more" (ephemeral — resets on reload).
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  // Find-in-conversation (main pane). App owns the open/close toggle — ⌘F opens it when focus is
  // in the main pane, Esc closes it; the query + match state live in MainPane. `paneRef` lets the
  // ⌘F handler tell whether focus is physically inside the main pane vs the rail.
  // One ref per pane. `inMain` is true when focus is inside EITHER, which is what routes ⌘F and keeps
  // the main area owning the keyboard; the focused pane (paneLayout.focusIndex) is what decides which
  // one acts on it.
  const pane0Ref = useRef<HTMLElement>(null)
  const pane1Ref = useRef<HTMLElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  // Bumped on every ⌘F while focus is in the main pane, so pressing ⌘F again (after clicking into
  // the transcript) re-focuses the find input even when the bar is already open. Threaded down to
  // TranscriptSearch, which focuses + selects whenever it changes.
  const [findFocusReq, setFindFocusReq] = useState(0)
  // If find opens over a live Terminal and we auto-switch to Formatted to search, remember the
  // prior view so closing find restores it.
  const findPriorViewRef = useRef<View | null>(null)

  // Begin buffering PTY output immediately, before any session is spawned.
  useEffect(() => {
    initPtyStream()
  }, [])

  // Recent PTY output is retained per terminal so one can be rebuilt in another pane or window without
  // coming up blank — which means it is retained until told otherwise. This is the "otherwise": the
  // live set is the authority, so a terminal that ended has its record dropped on the next change,
  // and no teardown path can be missed because none is consulted.
  useEffect(() => {
    retainOnly(new Set(ptys.active.map((p) => p.ptyId)))
  }, [ptys.active])

  // Read by subscriptions that must not re-subscribe on every layout change.
  const paneLayoutRef = useRef(paneLayout)
  paneLayoutRef.current = paneLayout

  // Conversations OTHER windows hold tabs for, as reported by main. Held in a ref as well as state:
  // `land` needs to consult it synchronously on every navigation, while the rail reads the state to
  // mark the rows so a click that jumps to another window is expected rather than startling.
  const [openElsewhere, setOpenElsewhere] = useState<Set<string>>(() => new Set())
  const openElsewhereRef = useRef(openElsewhere)
  openElsewhereRef.current = openElsewhere

  // Several tabs acted on as one. Kept beside the layout rather than inside it: a selection is about
  // what the user has picked out, not about what exists, and folding it into the reducer would make
  // every open and close have to say something about it.
  const [tabSelection, setTabSelection] = useState<TabSelection>(NO_SELECTION)
  const tabSelectionRef = useRef(tabSelection)
  tabSelectionRef.current = tabSelection
  // Tabs close, move panes and get rekeyed underneath a selection, so it is re-checked against the
  // layout after every change rather than at each call site — no path can forget. `pruneSelection`
  // returns its input by identity when nothing went, so the common case costs no render.
  useEffect(() => {
    setTabSelection((s) =>
      pruneSelection(
        s,
        paneLayout.panes.map((p) => p.tabs.map((t) => t.sessionId))
      )
    )
  }, [paneLayout])

  // ---- the two selection gestures, on TABS only ----
  // ⌘ and ⇧ are free here in a way they are not on a rail row: picking several out of a list is what
  // every editor and file browser uses them for, so on a tab strip they read as the convention rather
  // than as a borrowed browser trick.
  //
  // Declared HERE, beside the state, rather than beside the drag handlers where they are used — the
  // group-capable actions further down all call `targetsFor`, and a `const` defined after them is not
  // hoisted, so it would be a temporal-dead-zone error at the first one.
  const toggleTabSelected = useCallback((pane: number, sessionId: string) => {
    const p = paneLayoutRef.current.panes[pane]
    setTabSelection((s) => toggleSelected(s, pane, p ? paneActiveId(p) : null, sessionId))
  }, [])
  const extendTabSelection = useCallback((pane: number, sessionId: string) => {
    const order = paneLayoutRef.current.panes[pane]?.tabs.map((t) => t.sessionId) ?? []
    setTabSelection((s) => extendSelection(s, pane, order, sessionId))
  }, [])

  // What a command invoked on ONE tab should actually act on: the group when that tab belongs to one,
  // and just that tab otherwise. Every group-capable action goes through this, so "acts on the
  // selection" is one rule rather than a condition repeated at each of them.
  const targetsFor = useCallback(
    (pane: number, sessionId: string): string[] =>
      actionTargets(tabSelectionRef.current, pane, sessionId),
    []
  )
  const tabsEnabledRef = useRef(tabsEnabled)
  tabsEnabledRef.current = tabsEnabled

  // Switching the preference off collapses to the shape the off path expects: one pane holding one
  // preview tab, whatever was on screen. Fires on the transition only, so turning it back on starts
  // from that single tab rather than resurrecting a stale set.
  const tabsWereEnabled = useRef(tabsEnabled)
  useEffect(() => {
    if (tabsWereEnabled.current && !tabsEnabled) panes.collapseToSingle()
    tabsWereEnabled.current = tabsEnabled
  }, [tabsEnabled, panes.collapseToSingle])

  // A detached window opens straight onto the conversation it was created for, as a kept tab — it was
  // asked for by name, so it is not a preview. Runs once; the conversation index has not necessarily
  // loaded yet, which is fine, because a tab holds an id and the title fills in when it arrives.
  const openedInitialRef = useRef(false)
  useEffect(() => {
    const targets = windowInit.sessionIds
    if (targets.length === 0 || openedInitialRef.current) return
    openedInitialRef.current = true
    // In reverse, because `open` inserts AFTER the active tab: opening them front-to-back would land
    // each one before the last and reverse the group. The final iteration is the first id, which
    // therefore also ends up active — the tab the user was on when the group left.
    for (const id of [...targets].reverse()) panes.openTab(id, 'persistent')
  }, [panes.openTab])

  // ⌘W arrives as a push from the File menu, not a keydown: a menu accelerator is consumed by the app
  // and the key event never reaches the page. Close the focused pane's active tab; with none — no tabs
  // open, or the feature switched off — close the window instead, so the chord still does what every
  // other macOS app does with it.
  useEffect(() => {
    const off = window.api.onMenuCloseTab(() => {
      const l = paneLayoutRef.current
      const index = l.panes[l.focusIndex]?.activeIndex ?? -1
      if (tabsEnabledRef.current && index >= 0) panes.closeTab(l.focusIndex, index)
      else window.api.closeWindow()
    })
    return off
  }, [panes.closeTab])

  // A Codex PTY's sessionId changed — an initial bind off a placeholder, or a correction between two
  // real conversations. The two need OPPOSITE handling of session-keyed state, and getting it wrong
  // destroys durable data, so the decision lives in pure, mutation-checked `bindActions` and this
  // effect is only the wiring. See bindPolicy.ts and PtyBindKind.
  useEffect(() => {
    const off = window.api.onPtyBound((_ptyId, oldId, newId, kind) => {
      const act = bindActions({ oldId, newId, kind }, selectedIdRef.current)
      if (act.nav === 'rekey') rekeyNav(oldId, newId)
      else if (act.nav === 'retarget') retargetNav(oldId, newId)
      if (act.rekeySeen) rekeySeen(oldId, newId)
      if (act.retargetLiveOrder) retargetLiveOrder(oldId, newId)
      // Tabs are session-keyed too. `rekey` rewrites every tab holding a placeholder that is ceasing
      // to exist; `retarget` moves only the tab the user is standing on, leaving inactive tabs on the
      // old id alone — that conversation is still real, only the terminal moved.
      if (act.tabs === 'rekey') panes.rekeyTabs(oldId, newId)
      else if (act.tabs === 'retarget') panes.retargetTabs(oldId, newId)
      if (act.view === 'move') {
        setViewBySession((prev) => {
          if (!(oldId in prev)) return prev
          const next = { ...prev, [newId]: prev[oldId] }
          delete next[oldId]
          return next
        })
      } else if (act.view === 'copy') {
        // Carry the surface the user is standing on across, rather than letting the new
        // conversation's own remembered view flip a terminal they are typing in over to Formatted.
        // The old id keeps its entry — that conversation still exists.
        setViewBySession((prev) => ({ ...prev, [newId]: prev[oldId] ?? 'terminal' }))
      }
      if (act.focus) requestFocus(newId)
    })
    return off
  }, [
    rekeyNav,
    rekeySeen,
    requestFocus,
    retargetNav,
    retargetLiveOrder,
    panes.rekeyTabs,
    panes.retargetTabs
  ])

  // Keep the native macOS traffic lights aligned with the zoom-scaled title bar. A page zoom
  // (⌘+/⌘−, pinch) scales the whole renderer but not the OS-drawn buttons, so they'd drift out of
  // center; every zoom fires a `resize`, so we ping main on resize to reposition them (main reads
  // the authoritative zoom factor — see trafficLights.ts). Once on mount too, harmless at 100%.
  useEffect(() => {
    const sync = (): void => window.api.syncTrafficLights()
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  // The main pane always owns the keyboard. Whenever the selected conversation changes to a real
  // one — including via ⌘[ / ⌘] back/forward, which don't request focus themselves — focus its
  // surface so you can type (live) or hit Enter to resume (not-live). The explicit requestFocus in
  // the action handlers (click / switch / resume / go-live) still covers re-selecting the SAME
  // conversation, where this effect (keyed on selectedId) wouldn't fire.
  useEffect(() => {
    if (selectedId) requestFocus(selectedId)
  }, [selectedId, requestFocus])

  // --- the two halves of "what is selected" ---
  //
  // The pane layout is what is on screen; the back/forward history is a LOG of it. Every selection
  // change goes through the layout — a row click, a tab click, closing a tab, moving pane focus — and
  // this records the stop, so no action handler has to remember to. Re-recording the stop the user is
  // already on is an identity no-op in navReducer, which is what keeps this from fighting the effect
  // below.
  useEffect(() => {
    if (selectedId) open(selectedId)
    else home()
  }, [selectedId, open, home])

  // The one direction that starts in the history: ⌘[ / ⌘] move its cursor, and the conversation it
  // lands on has to be put into the focused pane. Preview mode, so retracing your steps does not
  // accumulate tabs.
  //
  // Keyed on `navSelectedId` ALONE, reading the current selection through a ref. Depending on
  // `selectedId` too would fire this in the same commit as a pane-driven change, where the effect
  // above has dispatched but its state has not landed yet — so it would see the history "disagreeing",
  // reconcile the wrong way, and bounce the user back to the conversation they just left.
  useEffect(() => {
    if (navSelectedId && navSelectedId !== selectedIdRef.current) {
      panes.openTab(navSelectedId, 'preview')
    }
  }, [navSelectedId, panes.openTab])

  // Keep the main-process LRU cap in lockstep with the persisted preference — on mount and on each
  // change. Fire-and-forget, and runs after commit, so it never touches the render/paint path.
  useEffect(() => {
    window.api.setMaxLiveSessions(maxLive)
  }, [maxLive])

  // Push the dark-dock-icon choice to main on mount + on change (main can't read renderer localStorage,
  // and a packaged dock resets to the bundled icon each launch, so re-pushing on mount restores it).
  useEffect(() => {
    window.api.setDockIcon(darkIcon.value)
  }, [darkIcon.value])

  // Focus the search field whenever it opens (magnifier click or ⌘F).
  useEffect(() => {
    if (searchOpen) {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [searchOpen])

  const allConversations = useMemo(() => groups.flatMap((g) => g.conversations), [groups])
  const metaById = useMemo(() => {
    const m = new Map<string, ConversationMeta>()
    for (const c of allConversations) m.set(c.sessionId, c)
    return m
  }, [allConversations])

  // A row is "provisional" when it's live but has no persisted meta yet — a new-Codex session before
  // its rollout binds, or a new-Claude session in the ~1s before its JSONL indexes. Its id is a
  // placeholder (Codex) or not-yet-on-disk (Claude), so id-keyed affordances (pin / rename / Session
  // details) are gated off until it has a real, persisted identity.
  const isProvisional = useCallback(
    (id: string) => ptys.bySession.has(id) && !metaById.has(id),
    [ptys.bySession, metaById]
  )

  // The set of sessions matching the active search, or null when not searching. The
  // query filters entries *within* every section (Pinned/Live/Recent) — it does not
  // replace them with a separate flat list.
  const matchIds = useMemo(
    () => (query.trim() ? new Set(searchConversations(allConversations, query).map((c) => c.sessionId)) : null),
    [allConversations, query]
  )
  const searching = matchIds !== null

  // The pane's three sections. Ordering is stable w.r.t. activity — positions key off
  // pin order and a manual Live order, never lastActivity/startedAt — so a session emitting
  // output never makes a row jump (see git ce407fa). The lone exception is the not-live
  // "Recent" history, which sorts by mtime because it IS a recency list. Live rows are
  // joined to their indexed meta so they carry a preview and a fresh (renamed/aiTitle) title.
  //   1. Pinned — pinned convos (live or not), most-recently-pinned on top.
  //   2. Live   — live & unpinned, in manual order (newest on top; drag to reorder).
  //   3. Recent — everything else (not live, not pinned), most-recent first.
  // When a search is active, each section is filtered to the matching sessions.
  // --- terminal ownership + per-pane resolution ---
  //
  // Which pane each live terminal is mounted in. STICKY, and that is the load-bearing part: a window
  // can hold only ONE xterm per terminal (the renderer's output fan-out keeps a single writer per pty
  // id, and a second one silently kills the first), so putting a terminal in the other pane means
  // unmounting and remounting it. A remounted xterm attaches to an empty backlog — no PTY output is
  // retained anywhere to replay — so it would come back blank until something changed its size.
  //
  // A terminal is therefore assigned a pane ONCE, when first seen, and moves only if that pane goes
  // away (an unsplit, which changes the surviving pane's width and so repaints it anyway).
  // The rule itself is pure and mutation-checked in lib/ptyHome.ts — this is only the wiring.
  //
  // Resolved DURING render, against a ref, rather than in an effect writing state. An effect would
  // leave a newly-spawned terminal homeless for one committed frame, and this pane would render it as
  // "the terminal is in the other pane" — a wrong message about a session that had only just started.
  // Writing the ref here is safe because `nextPtyHomes` is idempotent and returns its input by
  // identity when nothing changes, so a repeated render produces the same map and the same object.
  const ptyHomeRef = useRef<Record<string, number>>({})
  const ptyHome = useMemo(() => {
    ptyHomeRef.current = nextPtyHomes(ptyHomeRef.current, ptys.active, {
      paneCount: paneLayout.panes.length,
      focusIndex: paneLayout.focusIndex,
      paneOfSession: (id) => locateTab(paneLayout, id)?.pane ?? null
    })
    return ptyHomeRef.current
  }, [ptys.active, paneLayout])

  /**
   * One pane's resolved state.
   *
   * A live terminal renders only in its home pane. A conversation open in BOTH panes therefore shows
   * its terminal in the pane that owns it and its transcript in the other — the honest rendering of
   * one-xterm-per-terminal rather than a workaround for it, and useful in its own right: history on
   * one side, typing on the other.
   */
  const paneView = (index: number) => {
    const pane = paneLayout.panes[index] ?? null
    const id = pane ? paneActiveId(pane) : null
    const meta = id ? metaById.get(id) ?? null : null
    const pty = id ? ptys.bySession.get(id) ?? null : null
    // A terminal renders here only if this WINDOW owns it (main decides, one owner app-wide) and this
    // PANE is its home within the window. The two are independent gates, and the reason they differ
    // matters to the user: across windows the terminal can be moved here, across panes it cannot yet.
    const ownsTerminal = !!pty && pty.ownedHere && ptyHome[pty.ptyId] === index
    const terminalAt: 'here' | 'other-pane' | 'other-window' | null = !pty
      ? null
      : ownsTerminal
        ? 'here'
        : pty.ownedHere
          ? 'other-pane'
          : 'other-window'
    const requested: View = id
      ? viewBySession[id] ?? (pty ? 'terminal' : 'transcript')
      : 'transcript'
    return {
      pane,
      id,
      meta,
      pty,
      terminalAt,
      view: (requested === 'terminal' && ownsTerminal ? 'terminal' : 'transcript') as View,
      title: pty ? displayTitleForRow(pty, meta ?? synthMeta(pty)) : meta?.title ?? 'Conversation',
      cwd: meta?.cwd ?? pty?.cwd ?? ''
    }
  }
  // Exactly two, unconditionally — the split is capped at two panes, so these stay ordinary hook
  // calls rather than a loop over a variable count.
  const view0 = paneView(0)
  const view1 = paneView(1)
  const { transcript: transcript0, loading: loading0 } = useTranscript(
    view0.id,
    view0.view === 'transcript'
  )
  const { transcript: transcript1, loading: loading1 } = useTranscript(
    view1.id,
    view1.view === 'transcript'
  )
  const focusedView = paneLayout.focusIndex === 1 ? view1 : view0

  // Both panes' active conversations are genuinely on screen, so both count as being looked at — for
  // the liveness dot's "seen" rule and for marking read. A set keyed by id, since one conversation can
  // be the active tab of both panes at once.
  const visibleIds = useMemo(() => {
    const s = new Set<string>()
    if (view0.id) s.add(view0.id)
    if (view1.id) s.add(view1.id)
    return s
  }, [view0.id, view1.id])

  // THE composition of liveness for one session, hoisted so every surface reading it reads the same
  // value: the rail's sections, the Live tally, both tab strips, and the read/unread toggle. It was
  // previously hand-copied at each site, and `resolveRowLiveState` exists because one of those copies
  // was written without the unlinked gate. The tab strip then repeated the mistake one level up —
  // deriving `live: !!pty` and drawing a solid "finished, unseen" dot next to a rail row showing the
  // hollow "idle" one, for the same session at the same moment. Two derivations of one fact are two
  // claims about it, so there is one.
  const liveStateFor = useCallback(
    (pty: PtyState | null, meta: ConversationMeta, id: string): LiveState | null =>
      resolveRowLiveState(pty, meta, seen[id] ?? 0, focused && visibleIds.has(id), unread[id]),
    [seen, unread, focused, visibleIds]
  )

  // Live terminals partitioned by the pane that owns them. A terminal with no home yet appears in
  // NEITHER pane for one frame: mounting it in the wrong pane and moving it next frame would blank it,
  // and while it is unmounted the pty stream buffers its output rather than losing it.
  // Only terminals THIS window owns are candidates: one xterm per terminal app-wide, and main is the
  // authority on which window that is. A terminal owned elsewhere is mounted nowhere here, and the
  // pane showing its conversation offers to bring it over instead.
  const ptysByPane = useMemo<PtyState[][]>(
    () =>
      partitionPtys(
        ptys.active.filter((p) => p.ownedHere),
        ptyHome,
        paneLayout.panes.length
      ),
    [ptys.active, ptyHome, paneLayout.panes.length]
  )

  const railSections = useMemo<RailSection[]>(() => {
    const pinnedEntries: RailEntry[] = pinnedOrder
      .map((id) => {
        const pty = ptys.bySession.get(id) ?? null
        // Prefer indexed meta; fall back to the live process so a pinned-but-
        // unindexed session still renders a full row. Drop truly stale pins.
        const meta = metaById.get(id) ?? (pty ? synthMeta(pty) : null)
        return meta
          ? { sessionId: id, pty, meta, pinned: true, liveState: liveStateFor(pty, meta, id) }
          : null
      })
      .filter((e): e is RailEntry => e !== null)

    // Live & unpinned, in the manual order (newest on top; drag to reorder). Iterating liveOrder —
    // not a startedAt sort — is what keeps rows from ever jumping on their own. The guards are
    // defensive against the one-frame window before useLiveOrder's sync prunes a just-pinned /
    // just-ended id from the order.
    const liveEntries: RailEntry[] = liveOrder
      .map((id): RailEntry | null => {
        const pty = ptys.bySession.get(id)
        if (!pty || pinned.has(id)) return null
        const meta = metaById.get(id) ?? synthMeta(pty)
        return { sessionId: id, pty, meta, pinned: false, liveState: liveStateFor(pty, meta, id) }
      })
      .filter((e): e is RailEntry => e !== null)

    const recentEntries: RailEntry[] = allConversations
      .filter((c) => !pinned.has(c.sessionId) && !ptys.bySession.has(c.sessionId))
      .sort((a, b) => b.mtime - a.mtime)
      .map((c) => ({ sessionId: c.sessionId, pty: null, meta: c, pinned: false, liveState: null }))

    const all: RailSection[] = [
      { key: 'pinned', label: 'Pinned', variant: 'card', entries: pinnedEntries },
      { key: 'live', label: 'Live', variant: 'card', entries: liveEntries },
      { key: 'recent', label: 'Recent', variant: 'row', entries: recentEntries, cap: RECENT_CAP }
    ]
    const scoped = matchIds
      ? all.map((s) => ({ ...s, entries: s.entries.filter((e) => matchIds.has(e.sessionId)) }))
      : all
    return scoped.filter((s) => s.entries.length > 0)
  }, [pinned, pinnedOrder, liveOrder, metaById, ptys.bySession, allConversations, matchIds, liveStateFor])

  // Live-session tally over ALL live sessions — never the search-filtered rail set, so the rail's
  // count + status line reflect everything running even while a query narrows the visible rows.
  const liveTally = useMemo(() => {
    let working = 0
    let asking = 0
    // Named `unreadCount` (not `unread`) to avoid shadowing the `unread` seen-map from useSeen,
    // referenced as `unread[p.sessionId]` just below. Surfaced as the tally's `unread` field.
    let unreadCount = 0
    let idle = 0
    // Terminals with no proven conversation identity get their OWN count rather than being folded
    // into `idle`. Calling an unlinked terminal idle would be a claim about a conversation we can't
    // identify — and "1 idle" over a terminal the user is actively typing in is exactly the kind of
    // wrong-dot report this work exists to fix. Sharing the hollow visual does not fold it into idle.
    let unlinked = 0
    for (const p of ptys.active) {
      const st = liveStateFor(p, metaById.get(p.sessionId) ?? synthMeta(p), p.sessionId)
      // Every `p` here is live by construction, so the only way to get no state is the unlinked
      // gate — which makes this bucket definitionally "the rows that were given no dot" rather
      // than a second reading of the predicate that could drift from the first.
      if (st === null) unlinked++
      else if (st === 'working') working++
      else if (st === 'asking') asking++
      else if (st === 'awaiting') unreadCount++
      else idle++
    }
    return { count: ptys.active.length, working, asking, unread: unreadCount, idle, unlinked }
  }, [ptys.active, metaById, liveStateFor])

  // Capacity modal: warn once the live set reaches the configured cap (maxLive). `capWarnDismissed`
  // silences only the current episode — the re-arm effect clears it once the count drops back below
  // the cap, so the modal returns the next time you climb into it. Ephemeral (not persisted).
  // Memoized so its identity is stable (the keyboard effect depends on it, and a fresh object each
  // render would needlessly re-subscribe the listener).
  const [capWarnDismissed, setCapWarnDismissed] = useState(false)
  useEffect(() => {
    if (liveTally.count < maxLive) setCapWarnDismissed(false)
  }, [liveTally.count, maxLive])
  const capWarning = useMemo(
    () =>
      liveTally.count >= maxLive && !capWarnDismissed
        ? { count: liveTally.count, max: maxLive }
        : null,
    [liveTally.count, capWarnDismissed, maxLive]
  )

  // "This row stands for no conversation" (see rowIdentity), by id — the ONE place that resolution
  // lives. Every consumer of the gate routes through here rather than re-deriving it: an unlinked
  // row must not persist read state or a pin under an id that may never bind, and a gate copied per
  // call site is how one copy ends up missing (which is what put a stranger's liveness dot on a
  // background-agent row).
  const isUnlinkedId = useCallback(
    (id: string): boolean => {
      const pty = ptys.bySession.get(id) ?? null
      return !!pty && isUnlinkedRow(pty, metaById.get(id) ?? synthMeta(pty))
    },
    [ptys.bySession, metaById]
  )

  // Per-pane tab descriptors for the strips. Resolved here rather than in TabStrip so the strip stays
  // presentational, and so a tab's title comes from the SAME derivation the rail row and the pane
  // header use — a tab must not name one thing while the row beside it names another.
  const tabsByPane = useMemo<TabDescriptor[][]>(
    () =>
      paneLayout.panes.map((p) =>
        p.tabs.map((tab) => {
          const pty = ptys.bySession.get(tab.sessionId) ?? null
          const meta = metaById.get(tab.sessionId) ?? (pty ? synthMeta(pty) : null)
          return {
            sessionId: tab.sessionId,
            title: pty && meta ? displayTitleForRow(pty, meta) : meta?.title ?? 'Conversation',
            // The hover carries the rail row's preview line, since a tab truncates far harder than a
            // row does. A row falls back to a "No preview" placeholder to hold its height; a tooltip
            // has no height to hold, so absent a real preview the second line is simply omitted
            // rather than spending it saying there is nothing to say.
            subtitle:
              meta && pty && isParkedOnlyRow(pty, meta)
                ? 'Terminal only — work is in a background agent'
                : meta?.preview ?? null,
            preview: tab.preview,
            // Null meta implies null pty (meta falls back to the pty's stand-in whenever one exists),
            // so this resolves to "no dot" for exactly the sessions that have no state to report.
            dot: meta ? liveDotClass(pty, meta, liveStateFor(pty, meta, tab.sessionId)) : null,
            unlinked: isUnlinkedId(tab.sessionId)
          }
        })
      ),
    [paneLayout.panes, ptys.bySession, metaById, isUnlinkedId, liveStateFor]
  )

  // Activating a tab is a landing like any other: it marks the conversation read and hands the pane
  // the keyboard. The history stop is recorded by the selection effect, not here.
  const goToTab = useCallback(
    (pane: number, index: number) => {
      const id = paneLayout.panes[pane]?.tabs[index]?.sessionId
      if (!id) return
      // A plain click means "just this one", so it is also the way out of a multi-selection.
      setTabSelection(selectOnly())
      panes.activateTab(pane, index)
      if (!isUnlinkedId(id)) markRead(id)
      requestFocus(id)
    },
    [paneLayout.panes, panes.activateTab, isUnlinkedId, markRead, requestFocus]
  )

  // Closing a tab that belongs to a group closes the group — including from the ✕ and middle-click,
  // not just the menu, since those are the same act on the same tab.
  const closeTabsFrom = useCallback(
    (pane: number, index: number) => {
      const id = paneLayoutRef.current.panes[pane]?.tabs[index]?.sessionId
      if (!id) return
      const ids = targetsFor(pane, id)
      if (ids.length > 1) panes.closeTabs(ids)
      else panes.closeTab(pane, index)
    },
    [panes.closeTab, panes.closeTabs, targetsFor]
  )

  const selectedMeta = focusedView.meta
  const selectedPty = focusedView.pty
  const effectiveView = focusedView.view
  const selectedInputRequestedAt = selectedPty
    ? currentInputRequestedAt(selectedMeta ?? synthMeta(selectedPty), selectedPty.inputRequestedAt)
    : null
  // An unlinked row shows no read state, so it must not persist one either — see rowIdentity.
  const selectedUnlinked = selectedId ? isUnlinkedId(selectedId) : false

  // Looking at a conversation (visible in a pane + the window focused) marks it read: it advances the
  // seen marker AND clears any manual-unread override, so a turn finishing under your eyes drops the
  // dot to quiet. Applies to EVERY visible pane, not just the focused one — you can see both.
  const otherVisibleId = view0.id === selectedId ? view1.id : view0.id
  const otherVisibleMeta = otherVisibleId ? metaById.get(otherVisibleId) ?? null : null
  useEffect(() => {
    if (selectedId && focused && !selectedUnlinked) markRead(selectedId)
    if (otherVisibleId && focused && !isUnlinkedId(otherVisibleId)) markRead(otherVisibleId)
  }, [
    selectedId,
    otherVisibleId,
    focused,
    selectedUnlinked,
    isUnlinkedId,
    selectedMeta?.turnEndedAt,
    otherVisibleMeta?.turnEndedAt,
    selectedInputRequestedAt,
    markRead
  ])

  // Arrow-key order follows what's actually visible — the same visibility rule the pane
  // renders with (collapse + Recent cap + search override) — so nav never lands on a hidden row.
  const orderedIds = useMemo(
    () =>
      railSections.flatMap((s) =>
        visibleEntries(s, {
          collapsed: collapsedSections[s.key],
          expanded: expandedSections.has(s.key),
          searching
        }).map((e) => e.sessionId)
      ),
    [railSections, collapsedSections, expandedSections, searching]
  )
  // The new-conversation menu orders by when each repo's newest conversation was STARTED, not by
  // last activity. `groups` arrives sorted by `latestMtime` desc, which answers "where was I last?" —
  // a different question from "where am I likely to start something new?". Sort a COPY so the rail
  // keeps its own order. `firstActivityAt` is the first real message, so a session that was opened
  // but never typed in scores 0 and sinks — deliberate: an empty session isn't evidence you work there.
  const recentDirs = useMemo(() => {
    const startedAt = (g: (typeof groups)[number]): number =>
      g.conversations.reduce((max, c) => Math.max(max, c.firstActivityAt ?? 0), 0)
    return [...groups].sort((a, b) => startedAt(b) - startedAt(a)).map((g) => g.cwd)
  }, [groups])

  // Agent axis for "new conversation". `availableAgents` are the launchable CLIs. The agent is
  // RESOLVED (no choice to present) when a usable default is set, or when only one agent exists;
  // otherwise it's an open choice the menu must surface. Mirrors the directory axis (`resolvedDir`).
  const availableAgents = useMemo<AgentKind[]>(
    () => (['claude', 'codex'] as AgentKind[]).filter((a) => agents[a]),
    [agents]
  )
  const resolvedAgent = useMemo<AgentKind | null>(() => {
    if (defaultAgentEnabled && agents[defaultAgent]) return defaultAgent
    if (availableAgents.length === 1) return availableAgents[0]
    return null
  }, [defaultAgentEnabled, defaultAgent, agents, availableAgents])
  const resolvedDir = defaultDir || null
  // Which agent the New menu shows selected (and commits with when its segment is hidden): the sticky
  // last-picked agent if still available, else the resolved one, else the saved default, else the
  // first available.
  const menuAgent = useMemo<AgentKind>(() => {
    // An explicit, enabled default agent wins over the sticky last pick; otherwise the menu remembers
    // your last selection, falling back to the first available agent.
    if (defaultAgentEnabled && agents[defaultAgent]) return defaultAgent
    if (lastAgent && availableAgents.includes(lastAgent)) return lastAgent
    return availableAgents[0] ?? 'claude'
  }, [defaultAgentEnabled, defaultAgent, agents, lastAgent, availableAgents])

  // Settings mirrors what will actually happen at ⌘N: with <2 agents installed there's no choice to
  // make, so the control is shown disabled with the forced selection (the sole agent, or None when
  // none are installed). The persisted pref is left untouched, so reinstalling the second agent
  // restores it.
  const defaultAgentDisabled = availableAgents.length < 2
  const defaultAgentChoice: 'none' | AgentKind = defaultAgentDisabled
    ? availableAgents[0] ?? 'none'
    : defaultAgentEnabled
      ? defaultAgent
      : 'none'

  // --- actions: a live process is created ONLY by resume() or startNew() ---
  // Remember a conversation's chosen view so it sticks across navigation.
  const setSessionView = useCallback((id: string, v: View) => {
    setViewBySession((prev) => (prev[id] === v ? prev : { ...prev, [id]: v }))
  }, [])

  /**
   * Every landing on a conversation goes through here: it puts the conversation in a pane, and the
   * effect above records the history stop.
   *
   * This is the ONE place the tabs preference changes behaviour. With tabs off every landing is a
   * PREVIEW open, so the pane's single tab is replaced in place and the app behaves exactly as it did
   * before tabs existed — which is why nothing downstream needs to know about the flag.
   *
   * `persistent` is for landings that ACT on a conversation rather than peek at it — Resume, New, and
   * ⏎ into a live terminal. Acting on it is what makes a tab stick, the same way editing a file does
   * in an editor.
   */
  const land = useCallback(
    (id: string, mode: OpenMode, opts?: { pane?: number; focus?: boolean }) => {
      // One conversation, one tab — across windows as well as across panes. Within this window the
      // reducer handles it; another window's tab is only knowable through main, so it is decided here.
      // The rule matches the reducer's exactly: an implicit open reveals the tab where it is, an
      // explicit placement takes it. Read from a ref and answered synchronously — a round trip before
      // opening a tab would put main's latency on the most-travelled path in the app.
      if (openElsewhereRef.current.has(id) && !locateTab(paneLayoutRef.current, id)) {
        if (opts?.pane === undefined) {
          window.api.revealConversation(id)
          return
        }
        window.api.claimConversation(id)
      }
      panes.openTab(id, tabsEnabled ? mode : 'preview', opts)
    },
    [panes.openTab, tabsEnabled]
  )

  // `pane` is passed explicitly by the per-pane header buttons rather than relying on the pointer
  // having already moved keyboard focus to that pane — the spawn must land where the button lives.
  const resume = useCallback(async (meta: ConversationMeta, pane?: number) => {
    land(meta.sessionId, 'persistent', { pane })
    setSessionView(meta.sessionId, 'terminal')
    requestFocus(meta.sessionId)
    await window.api.resume(meta.sessionId, meta.cwd, meta.agent, meta.title)
  }, [land, requestFocus, setSessionView])

  const startNew = useCallback(async (cwd: string, agent: AgentKind) => {
    setMenuOpen(false)
    setLastAgent(agent) // starting an agent makes it the sticky menu default too
    const st = await window.api.startNew(cwd, agent)
    land(st.sessionId, 'persistent')
    setSessionView(st.sessionId, 'terminal')
    requestFocus(st.sessionId)
  }, [land, requestFocus, setSessionView])

  const pickOther = useCallback(
    async (agent: AgentKind) => {
      const dir = await window.api.pickDirectory()
      if (dir) await startNew(dir, agent)
    },
    [startNew]
  )

  // The "+" / ⌘N primary action. Spawn straight away only when BOTH axes are settled — a usable
  // default directory AND a resolved agent (a usable default-agent, or the sole installed one). A
  // failed spawn (e.g. a stale default dir) falls back to the menu. Otherwise
  // toggle the menu, which presents exactly the unresolved choice(s): the agent segment and/or the
  // directory list.
  const newConversation = useCallback(() => {
    if (resolvedDir && resolvedAgent) {
      void startNew(resolvedDir, resolvedAgent).catch(() => setMenuOpen(true))
    } else {
      setMenuOpen((o) => !o)
    }
  }, [resolvedDir, resolvedAgent, startNew])

  // Right-clicking the "+" always opens the chooser, even when a default is set — the escape hatch to
  // start somewhere else once without clearing the default in Preferences.
  const openNewMenu = useCallback(() => setMenuOpen(true), [])

  // Preferences (App page) handlers for the default folder. A chosen folder is always active (no
  // on/off toggle), so choosing sets it and clearing forgets it.
  const chooseDefaultDir = useCallback(async () => {
    const dir = await window.api.pickDirectory()
    if (dir) setDefaultDir(dir)
  }, [setDefaultDir])
  const clearDefaultDir = useCallback(() => setDefaultDir(''), [setDefaultDir])

  // The default-agent setting is a single tri-state (None / Claude Code / Codex), like Theme — no
  // separate on/off toggle. 'none' just disables it (keeping the last agent value, unused).
  const setDefaultAgentChoice = useCallback(
    (value: 'none' | AgentKind) => {
      if (value === 'none') {
        setDefaultAgentEnabled(false)
        return
      }
      setDefaultAgent(value)
      setDefaultAgentEnabled(true)
    },
    [setDefaultAgent, setDefaultAgentEnabled]
  )

  // `pane` targets the pane whose header was clicked, which is not necessarily the focused one.
  const goLive = useCallback(
    (pane?: number) => {
      const l = paneLayoutRef.current
      const index = pane ?? l.focusIndex
      const target = l.panes[index]
      const id = target ? paneActiveId(target) : null
      if (!id) return
      if (pane !== undefined && pane !== l.focusIndex) panes.focusPane(pane)
      setSessionView(id, 'terminal')
      requestFocus(id)
    },
    [panes.focusPane, requestFocus, setSessionView]
  )
  // Enter/focus a live conversation's terminal: record a history stop, switch to the Terminal
  // view, and hand it the keyboard so you can type immediately. The optional `id` lets a switch /
  // click target a row that isn't selected yet; with no arg it acts on `selectedId`. Shared by
  // ⏎ (from Formatted), a live-row click, and the ⌥⌘↑/↓ switch (every call site guards on a live
  // pty, so a not-live selection never lands here).
  const enterLive = useCallback((id?: string) => {
    const target = id ?? selectedId
    if (!target) return
    // Going into a live terminal is acting on the conversation, so its tab stops being a preview.
    land(target, 'persistent')
    setSessionView(target, 'terminal')
    requestFocus(target)
  }, [selectedId, land, setSessionView, requestFocus])
  // Navigation restores each conversation's remembered surface. A live conversation with no choice
  // yet defaults to Terminal; explicit actions (Resume / New / Enter / Go live) still force Terminal.
  const openRemembered = useCallback(
    (id: string, mode: OpenMode = 'preview') => {
      land(id, mode)
      // Deliberately opening a conversation IS attention, whatever the OS says about window focus —
      // so read state doesn't rest on that one signal, and losing it can't strand a row unread.
      // Gated like every other read-state write: an unlinked row must not persist a marker.
      if (!isUnlinkedId(id)) markRead(id)
      requestFocus(id)
      if (!ptys.bySession.has(id) || viewBySession[id] === 'transcript') {
        // Land focus synchronously while the cached/new transcript is resolving; TranscriptView
        // refines this onto its scroll container once mounted. Read through the ref so this callback
        // needs no dependency on the layout.
        const target = paneLayoutRef.current.focusIndex === 1 ? pane1Ref : pane0Ref
        target.current?.focus({ preventScroll: true })
      }
    },
    [land, requestFocus, ptys.bySession, viewBySession, isUnlinkedId, markRead]
  )
  const clickLive = useCallback((id: string) => openRemembered(id), [openRemembered])
  const clickConversation = useCallback((id: string) => openRemembered(id), [openRemembered])
  const switchTo = useCallback((id: string) => openRemembered(id), [openRemembered])
  // Double-click a row: keep it. The editor gesture for promoting a preview tab, and the reason it
  // needs no click-count dedupe is that the two ordinary clicks preceding it are idempotent here —
  // they open (or re-activate) the same conversation, and re-opening the current history stop is an
  // identity no-op. Inert when tabs are off, where every landing is a preview open anyway.
  const stickConversation = useCallback(
    (id: string) => openRemembered(id, 'persistent'),
    [openRemembered]
  )
  // The ⋮ menu's "Open to the Side": show it in the OTHER pane, creating the split if there isn't one
  // yet. Both dispatches queue on the same reducer and apply in order, so the new pane exists by the
  // time the open lands in it. Passing an explicit `pane` also makes this a PLACEMENT, so a
  // conversation already open elsewhere moves here rather than merely being revealed.
  const openToSide = useCallback(
    (id: string) => {
      const l = paneLayoutRef.current
      const target = l.panes.length > 1 ? (l.focusIndex === 0 ? 1 : 0) : 1
      if (l.panes.length < 2) panes.splitPane()
      land(id, 'persistent', { pane: target })
      if (!isUnlinkedId(id)) markRead(id)
      requestFocus(id)
    },
    [panes.splitPane, land, isUnlinkedId, markRead, requestFocus]
  )
  // Send an EXISTING tab to the other pane, creating the split when there is none. Distinct from
  // openToSide, which opens a conversation over there and leaves whatever was here alone: this is a
  // move, so the source pane gives the tab up.
  const splitRightTab = useCallback(
    (sessionId: string, fromPane: number) => {
      const l = paneLayoutRef.current
      const ids = targetsFor(fromPane, sessionId)
      if (ids.length === 0) return
      // "Right" is pane 1: the menu item is offered only from the left pane (see canSplitRight), so
      // there is no other direction to resolve.
      if (l.panes.length < 2) panes.splitPane()
      panes.moveTabs(ids, { pane: 1, index: l.panes[1]?.tabs.length ?? 0 })
      panes.focusPane(1)
      if (!isUnlinkedId(sessionId)) markRead(sessionId)
      requestFocus(sessionId)
    },
    [panes.splitPane, panes.moveTabs, panes.focusPane, targetsFor, isUnlinkedId, markRead, requestFocus]
  )
  // Move a tab to the pane it is not in. Only reachable when a split already exists, so "the other
  // pane" is unambiguous — which is why one handler serves both Move Right and Move Left.
  const moveTabToOtherPane = useCallback(
    (sessionId: string, fromPane: number) => {
      const l = paneLayoutRef.current
      if (l.panes.length < 2) return
      const ids = targetsFor(fromPane, sessionId)
      if (ids.length === 0) return
      const to = fromPane === 0 ? 1 : 0
      panes.moveTabs(ids, { pane: to, index: l.panes[to]?.tabs.length ?? 0 })
      panes.focusPane(to)
      if (!isUnlinkedId(sessionId)) markRead(sessionId)
      requestFocus(sessionId)
    },
    [panes.moveTabs, panes.focusPane, targetsFor, isUnlinkedId, markRead, requestFocus]
  )
  // "Split Right" CREATES the second pane, so it is offered only when there is not one — otherwise the
  // action is a move and says so. Also requires two tabs here: moving the only one empties this pane,
  // the layout collapses it, and the net effect would be no split at all.
  const canSplitRightFrom = useCallback(
    (index: number): boolean =>
      paneLayout.panes.length === 1 && index === 0 && (paneLayout.panes[0]?.tabs.length ?? 0) >= 2,
    [paneLayout.panes]
  )
  // A tab was dragged onto a strip in THIS window: a reorder, or a move between panes.
  const moveTabHere = useCallback(
    (from: { pane: number; index: number }, to: { pane: number; index: number }) => {
      panes.moveTab(from, to)
      panes.focusPane(to.pane)
    },
    [panes.moveTab, panes.focusPane]
  )
  // A dragged multi-selection landed on a strip in this window.
  const moveTabGroupHere = useCallback(
    (sessionIds: string[], to: { pane: number; index: number }) => {
      panes.moveTabs(sessionIds, to)
      panes.focusPane(to.pane)
    },
    [panes.moveTabs, panes.focusPane]
  )
  // A tab was dragged OUT of this window — another window took it, or it became a window of its own.
  // Either way this window gives it up, which is what makes the gesture a move rather than a copy.
  const tabLeftWindow = useCallback(
    (sessionId: string) => {
      const at = locateTab(paneLayoutRef.current, sessionId)
      if (at) panes.closeTab(at.pane, at.index)
    },
    [panes.closeTab]
  )
  // MOVE a conversation into its own window: the new window opens with it, and this window gives up
  // its tab. A move rather than a copy, matching every other way a tab travels here (drag, Move Right,
  // Move Left) — and it is what keeps one conversation from being open in two places at once.
  //
  // The tab is what moves; the live TERMINAL does not follow. One xterm per terminal app-wide, and
  // yanking it would blank the session someone may be typing in — so the new window shows the
  // transcript and offers to bring the terminal over, which is now a repaint rather than a loss.
  const moveToNewWindow = useCallback(
    (id: string) => {
      const at = locateTab(paneLayoutRef.current, id)
      // A group goes to ONE new window holding all of it, not one window each.
      const ids = at ? targetsFor(at.pane, id) : [id]
      window.api.openConversationWindow(ids)
      panes.closeTabs(ids)
    },
    [panes.closeTabs, targetsFor]
  )
  // A tab dragged in from ANOTHER window. It lands as a KEPT tab in the focused pane: a drop is a
  // deliberate act, so it should not be replaceable by the next ordinary click the way a preview is.
  // Its position within the strip is deliberately not honoured — the OS gave the source window the
  // pointer, so where the cursor sits inside THIS window is not knowable here, and appending is
  // honest where guessing a slot would not be.
  useEffect(
    () =>
      window.api.onTabDropHere((sessionId: string) => {
        land(sessionId, 'persistent')
        if (!isUnlinkedId(sessionId)) markRead(sessionId)
        requestFocus(sessionId)
      }),
    [land, isUnlinkedId, markRead, requestFocus]
  )
  // Keep main's register of which window holds which conversation current. Keyed on the SET, not on the
  // layout: activating a tab, reordering the strip and resizing the split all leave the set alone, and
  // this should not chatter for any of them.
  const openIdsKey = useMemo(
    () => [...openSessionIds(paneLayout)].sort().join(' '),
    [paneLayout]
  )
  useEffect(() => {
    window.api.tabsChanged(openIdsKey ? openIdsKey.split(' ') : [])
  }, [openIdsKey])

  useEffect(() => {
    const offElsewhere = window.api.onTabsElsewhere((ids: string[]) => {
      setOpenElsewhere(new Set(ids))
    })
    // Another window asked us to show a conversation we hold. `openTab` on an existing tab activates
    // it and focuses its pane — main has already raised the window.
    const offActivate = window.api.onTabActivate((sessionId: string) => {
      if (locateTab(paneLayoutRef.current, sessionId)) panes.openTab(sessionId, 'persistent')
    })
    // Another window is taking it. Give the tab up — that is what makes an explicit placement a move
    // rather than a copy.
    const offRelease = window.api.onTabRelease((sessionId: string) => {
      const at = locateTab(paneLayoutRef.current, sessionId)
      if (at) panes.closeTab(at.pane, at.index)
    })
    return () => {
      offElsewhere()
      offActivate()
      offRelease()
    }
  }, [panes.openTab, panes.closeTab])

  // Show that this window will accept a tab currently being dragged over it. Driven by main, because
  // this window receives no pointer events at all while another one holds the drag.
  useEffect(() => {
    const mark = (on: boolean) => (): void => {
      document.body.classList.toggle('sb-window-drop-target', on)
    }
    const offOver = window.api.onTabDragOver(mark(true))
    const offLeave = window.api.onTabDragLeave(mark(false))
    return () => {
      offOver()
      offLeave()
      document.body.classList.remove('sb-window-drop-target')
    }
  }, [])
  // Take a live terminal over from whichever window currently holds it, then show it. One xterm per
  // terminal app-wide, so this is a move, not a copy — the other window falls back to the transcript.
  const claimTerminal = useCallback(
    (ptyId: string, pane: number) => {
      window.api.claimTerminal(ptyId)
      goLive(pane)
    },
    [goLive]
  )
  const toggleSplit = useCallback(() => {
    if (paneLayoutRef.current.panes.length > 1) panes.unsplit()
    else panes.splitPane()
  }, [panes.splitPane, panes.unsplit])
  const killSession = useCallback((ptyId: string) => window.api.kill(ptyId), [])
  // Stop a session by its conversation id — the rail's right-click menu works in session ids, while
  // the PtyManager kills by ptyId, so resolve the live process first (mirrors the pane header's
  // onKill). A no-op if the conversation isn't live.
  const stopSession = useCallback(
    (id: string) => {
      const pty = ptys.bySession.get(id)
      if (pty) killSession(pty.ptyId)
    },
    [ptys.bySession, killSession]
  )
  // Resume a not-live conversation by id — the rail's right-click menu works in session ids, so
  // resolve id→meta and run the shared resume() (which spawns the process and focuses its terminal,
  // like the pane-header Resume / ⏎). A no-op if the id isn't indexed.
  const resumeSession = useCallback(
    (id: string) => {
      const meta = metaById.get(id)
      if (meta) void resume(meta)
    },
    [metaById, resume]
  )

  // Pin/unpin, gated so a provisional row (no persisted identity yet) can't enter the persisted pin
  // store under a placeholder id that would orphan once it binds to its real id.
  const togglePinGated = useCallback(
    (id: string) => {
      if (!isProvisional(id)) togglePin(id)
    },
    [isProvisional, togglePin]
  )

  // Option+click marks a live row unread. Gated for the same reason pins are: `useSeen` persists to
  // localStorage, and an unlinked terminal's id is a placeholder that may never become a real
  // conversation — so the entry would be a permanent orphan under an id nothing can ever match. It
  // would also be marking a row that deliberately shows no read/unread state at all.
  const markUnreadGated = useCallback(
    (id: string) => {
      if (isUnlinkedId(id)) return
      markUnread(id)
    },
    [isUnlinkedId, markUnread]
  )

  // Open the conversation-info modal for a row/title. `edit` starts it in title-edit mode (the
  // right-click "Rename" entry point); clicking the pane title opens it in view mode. Opening the
  // modal does NOT select or navigate — it's an overlay over the current view. Gated off while
  // provisional: there's no persisted conversation to show details for / rename yet.
  const showInfo = useCallback(
    (id: string, edit: boolean) => {
      if (isProvisional(id)) return
      setInfoModal({ sessionId: id, edit })
    },
    [isProvisional]
  )
  // Set/clear a conversation's title. Fire-and-forget: main appends Claude Code's own custom-title
  // line then re-indexes + broadcasts, so the new title flows back through useSessions to the rail,
  // pane header, and the (still-open) info modal. An empty title resets to the auto-generated one.
  const renameConversation = useCallback((id: string, title: string) => {
    void window.api.renameConversation(id, title)
  }, [])

  // Toggle the search box; closing it clears the query so filtering ends with it.
  const toggleSearch = useCallback(() => {
    setSearchOpen((o) => {
      if (o) setQuery('')
      return !o
    })
  }, [])

  // Reveal the rest of a capped section (the Recent "Show more").
  const showMore = useCallback((key: string) => {
    setExpandedSections((s) => new Set(s).add(key))
  }, [])

  // Resolve the current dot state for any session id (used by the read/unread toggle). Null for any
  // unlinked row — it has no dot to toggle, and ⇧⌘U would otherwise persist an override for a
  // conversation the row isn't showing.
  const liveStateOf = useCallback(
    (id: string): LiveState | null => {
      const pty = ptys.bySession.get(id) ?? null
      if (!pty) return null
      return liveStateFor(pty, metaById.get(id) ?? synthMeta(pty), id)
    },
    [ptys.bySession, metaById, liveStateFor]
  )

  // Toggle a live conversation read/unread: a solid (awaiting) OR pulsing (asking) dot → read;
  // anything else → unread (which restores the pulse on a question state — see resolveLiveState).
  // Non-live rows have no dot, so it's a no-op there.
  const toggleUnread = useCallback(
    (id: string) => {
      const st = liveStateOf(id)
      if (st == null) return
      if (st === 'awaiting' || st === 'asking') markRead(id)
      else markUnread(id)
    },
    [liveStateOf, markRead, markUnread]
  )

  // Clear a manual "unread" mark once the user genuinely engages the open conversation — a click
  // or keystroke in the pane body (see MainPane's listener). Gated on an existing flag so plain
  // typing in the terminal doesn't churn state past the first keystroke.
  const onEngage = useCallback(() => {
    if (selectedId && unread[selectedId] != null) markRead(selectedId)
  }, [selectedId, unread, markRead])

  // Find-in-conversation searches the rendered transcript, so the first keystroke while a live
  // Terminal is showing switches to Formatted (remembering the prior view to restore on close).
  const onFindActivate = useCallback(() => {
    if (selectedId && effectiveView === 'terminal') {
      findPriorViewRef.current = 'terminal'
      setSessionView(selectedId, 'transcript')
    }
  }, [selectedId, effectiveView, setSessionView])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    const prior = findPriorViewRef.current
    findPriorViewRef.current = null
    // Restore the live Terminal if find pulled us off it (and the session is still live).
    if (prior === 'terminal' && selectedId && selectedPty) setSessionView(selectedId, 'terminal')
  }, [selectedId, selectedPty, setSessionView])

  // The pane-header magnifier toggles find (closeFind restores the prior view on the way out).
  const toggleFind = useCallback(() => {
    if (findOpen) closeFind()
    else setFindOpen(true)
  }, [findOpen, closeFind])

  // --- keyboard ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      const inInput = document.activeElement?.tagName === 'INPUT'
      // Focus physically inside the main pane (transcript or terminal) vs the rail/list. Routes ⌘F
      // (find-in-conversation vs search-conversations) and keeps the main pane owning the keyboard —
      // so arrows/Enter don't drive list-nav while you're reading the transcript or in the terminal.
      const inMain =
        !!pane0Ref.current?.contains(document.activeElement) ||
        !!pane1Ref.current?.contains(document.activeElement)
      // Focus on the read-only Formatted transcript specifically (its scroll container) — not a
      // pane-header button, not the live terminal. Gates Enter-to-resume from the transcript.
      const inTranscript =
        document.activeElement instanceof HTMLElement &&
        document.activeElement.classList.contains('transcript-scroll')
      // While the Preferences modal is open it owns the keyboard: Esc closes it; ⌘, and ⌘?
      // toggle between (or out of) the App / Shortcuts pages; everything else is
      // inert (no list-nav behind the scrim).
      if (settingsPage !== null) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setSettingsPage(null)
        } else if (mod && e.key === ',') {
          e.preventDefault()
          setSettingsPage((p) => (p === 'appearance' ? null : 'appearance'))
        } else if (mod && (e.key === '/' || e.key === '?')) {
          e.preventDefault()
          setSettingsPage((p) => (p === 'shortcuts' ? null : 'shortcuts'))
        }
        return
      }
      // While the capacity modal is up it owns the keyboard like Preferences: Esc dismisses it,
      // everything else is inert (no list-nav behind the scrim).
      if (capWarning) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setCapWarnDismissed(true)
        }
        return
      }
      // The conversation-info modal owns the keyboard the same way: Esc closes it, the rest is inert.
      // (While its title field is editing, the input's own Esc handler stopPropagation's to cancel the
      // edit without bubbling here — so a first Esc backs out of edit, a second closes the modal.)
      if (infoModal) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setInfoModal(null)
        }
        return
      }
      if (tabsEnabled && e.metaKey && e.shiftKey && !e.altKey && e.code === 'KeyN') {
        // ⇧⌘N — open the selected conversation in its own window. Must come BEFORE the ⌘N branch:
        // that one matches on `e.key.toLowerCase()`, so Shift+N lowercases to 'n' and it would
        // otherwise swallow this chord and start a new conversation instead. (The same shadowing
        // still applies to ⇧⌘F and ⇧⌘B, which nothing binds.)
        e.preventDefault()
        if (selectedId && !selectedUnlinked) moveToNewWindow(selectedId)
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        newConversation()
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        if (inMain && selectedId) {
          // Focus is in the main pane → find within the open conversation. Also bump the focus
          // request so ⌘F re-focuses the input even when the bar is already open (setFindOpen(true)
          // is a no-op then) — e.g. after clicking into the transcript to read it.
          setFindOpen(true)
          setFindFocusReq((n) => n + 1)
        } else {
          // List / rail focus (or nothing open) → the existing cross-conversation search.
          setSearchOpen(true)
          searchRef.current?.focus()
          searchRef.current?.select()
        }
      } else if (mod && e.code === 'KeyB') {
        e.preventDefault()
        togglePane()
      } else if (mod && e.altKey && (e.code === 'ArrowDown' || e.code === 'ArrowUp')) {
        // ⌥⌘↓ / ⌥⌘↑ — switch to the next / previous conversation (Chrome-tab style) and focus the
        // main pane on its remembered surface (a never-opened live session defaults to Terminal;
        // not-live always resolves to Formatted). e.code (not e.key) per the ⌘⌥ Option-key gotcha.
        // Works from inside a live terminal too — Cmd-combos bubble past xterm. Clamps at the ends;
        // from "nothing selected" both directions seed the first row.
        e.preventDefault()
        if (orderedIds.length > 0) {
          const idx = selectedId ? orderedIds.indexOf(selectedId) : -1
          const delta = e.code === 'ArrowDown' ? 1 : -1
          const next = idx < 0 ? 0 : Math.min(orderedIds.length - 1, Math.max(0, idx + delta))
          const nid = orderedIds[next]
          if (nid) switchTo(nid)
        }
      } else if (
        tabsEnabled &&
        mod &&
        e.altKey &&
        (e.code === 'ArrowLeft' || e.code === 'ArrowRight')
      ) {
        // ⌥⌘← / ⌥⌘→ — previous / next TAB, walking both panes' strips as one continuous line. The
        // vertical pair above walks the rail; the horizontal pair walks the strip, which is the axis
        // each one is laid out on. This WRAPS where the rail clamps — see stepTab for why a handful of
        // tabs and a long list want opposite answers.
        e.preventDefault()
        const target = stepTab(paneLayout, e.code === 'ArrowRight' ? 1 : -1)
        if (target) goToTab(target.pane, target.index)
      } else if (tabsEnabled && e.metaKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        // ⌘1…⌘9 — the Nth tab of the focused pane. ⌘0 is deliberately excluded: it is Reset Zoom.
        //
        // Bound on ⌘ ALONE, never this handler's `mod` (which is ⌘-or-⌃). ⌃1…⌃9 are meaningful inside
        // a TUI, and swallowing them in the renderer would break the agent running in the terminal.
        // Every chord added for tabs follows that rule.
        e.preventDefault()
        const index = Number(e.key) - 1
        const pane = paneLayout.panes[paneLayout.focusIndex]
        if (pane && index < pane.tabs.length) goToTab(paneLayout.focusIndex, index)
      } else if (tabsEnabled && e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backslash') {
        // ⌘\ — toggle the vertical split. Opening creates an EMPTY pane and takes the keyboard there,
        // so nothing is duplicated and you pick what goes beside; closing merges its tabs back into
        // the survivor, keeping whatever you were looking at selected. ⇧⌘\ is deliberately left free.
        // `e.code`, since ⌘ leaves `e.key` as '\' but Shift would make it '|'.
        e.preventDefault()
        toggleSplit()
      } else if (mod && e.shiftKey && e.code === 'KeyU') {
        // ⇧⌘U — toggle read/unread on the selected conversation (macOS Mail's shortcut).
        e.preventDefault()
        if (selectedId) toggleUnread(selectedId)
      } else if (mod && e.key === ',') {
        // ⌘, — macOS-standard Preferences shortcut; opens the Preferences modal to its Appearance page.
        e.preventDefault()
        setSettingsPage('appearance')
      } else if (mod && (e.key === '/' || e.key === '?')) {
        // Displayed as ⌘? (reads as "help"); accept ⌘/ too so Shift doesn't matter. Opens the
        // Preferences modal to its Shortcuts page.
        e.preventDefault()
        setSettingsPage('shortcuts')
      } else if (mod && e.key === '[') {
        // Browser-style back: retrace to the previously-opened conversation.
        e.preventDefault()
        back()
      } else if (mod && e.key === ']') {
        e.preventDefault()
        forward()
      } else if (e.key === 'Escape') {
        if (findOpen) closeFind()
        else if (query) setQuery('')
        else setSearchOpen(false)
        setMenuOpen(false)
      } else if (e.key === 'Enter' && !inInput && selectedId && inTranscript) {
        // ⏎ from the read-only Formatted transcript: a not-live conversation resumes; a live one
        // (shown in Formatted) jumps into its terminal — so you can read history and hit Enter to
        // bring it live. Gated to the transcript scroll container (inTranscript), so pane-header
        // buttons and the live terminal (where xterm consumes Enter) are never hijacked.
        e.preventDefault()
        if (selectedPty) enterLive()
        else if (selectedMeta) void resume(selectedMeta)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    query,
    settingsPage,
    capWarning,
    infoModal,
    findOpen,
    closeFind,
    selectedId,
    selectedMeta,
    selectedPty,
    orderedIds,
    resume,
    enterLive,
    switchTo,
    back,
    forward,
    togglePane,
    toggleUnread,
    newConversation,
    tabsEnabled,
    paneLayout,
    goToTab,
    toggleSplit,
    moveToNewWindow,
    selectedUnlinked
  ])

  // Find belongs to whichever pane has the keyboard. Moving to the other pane closes it rather than
  // teleporting the bar: the query lives in that pane's own component, so it could not follow anyway.
  useEffect(() => {
    setFindOpen(false)
  }, [paneLayout.focusIndex])

  // Resolve the info-modal target's meta + live process. A live-but-unindexed session still resolves
  // via the synthesized meta, mirroring the rail.
  const infoPty = infoModal ? ptys.bySession.get(infoModal.sessionId) ?? null : null
  const infoMeta = infoModal
    ? metaById.get(infoModal.sessionId) ?? (infoPty ? synthMeta(infoPty) : null)
    : null

  return (
    <div className="sb-app">
      <AppVeil />
      <TitleBar
        paneCollapsed={paneCollapsed}
        onTogglePane={togglePane}
        // The wordmark goes back to the welcome screen. With tabs open that is a pane showing nothing
        // rather than a window with nothing in it — the tabs stay put, which is why `deselect` exists
        // instead of this either closing them or becoming a control that silently does nothing.
        onHome={panes.deselect}
        onOpenSettings={() => setSettingsPage('appearance')}
        resolvedTheme={themeResolved}
        onToggleTheme={toggleTheme}
        updatesNeedAttention={updates.needsAttention}
        split={paneLayout.panes.length > 1}
        onToggleSplit={tabsEnabled ? toggleSplit : undefined}
      />
      <div className="sb-body" style={{ '--pane-w': `${paneWidth}px` } as CSSProperties}>
        {!paneCollapsed && (
          <TallyRail
            sections={railSections}
            live={liveTally}
            loading={loading}
            selectedSessionId={selectedId}
            onJump={clickLive}
            onSelect={clickConversation}
            onStick={tabsEnabled ? stickConversation : undefined}
            openElsewhere={openElsewhere}
            onOpenToSide={tabsEnabled ? openToSide : undefined}
            onOpenInNewWindow={tabsEnabled ? moveToNewWindow : undefined}
            onTogglePin={togglePinGated}
            query={query}
            onQueryChange={setQuery}
            searchRef={searchRef}
            searchOpen={searchOpen}
            onSearchToggle={toggleSearch}
            searching={searching}
            collapsedSections={collapsedSections}
            onToggleSection={toggleSection}
            expandedSections={expandedSections}
            onShowMore={showMore}
            menuOpen={menuOpen}
            onMenuToggle={newConversation}
            onNewContextMenu={openNewMenu}
            onMenuClose={() => setMenuOpen(false)}
            recentDirs={recentDirs}
            menuDefaultDir={defaultDir}
            menuAgents={availableAgents}
            menuAgent={menuAgent}
            onMenuAgentChange={setLastAgent}
            onChoose={startNew}
            onPickOther={pickOther}
            defaultDirActive={!!defaultDir}
            defaultDirLabel={defaultDir ? basename(defaultDir) : ''}
            onToggleUnread={toggleUnread}
            onMarkUnread={markUnreadGated}
            onResumeSession={resumeSession}
            onStopSession={stopSession}
            onShowInfo={showInfo}
            onReorderPins={commitReorder}
            pinnedOrder={pinnedOrder}
            onReorderLive={commitLiveReorder}
            liveOrder={liveOrder}
            reorderTick={reorderTick}
          />
        )}
        {!paneCollapsed && (
          <ResizeHandle
            ariaLabel="Resize pane"
            onResizeStart={() => {
              dragStartRef.current = paneWidth
            }}
            onResize={(dx) => setPaneWidth(dragStartRef.current + dx)}
            onReset={resetPane}
          />
        )}
        {/* One or two conversation panes side by side. Keyed by the pane's own id, not its index, so
            splitting and unsplitting never remounts a surviving pane — which would drop its terminal
            deck, its find state, and every remembered transcript position. */}
        <div
          className={`sb-panes${paneLayout.panes.length > 1 ? ' split' : ''}`}
          ref={panesElRef}
        >
          {paneLayout.panes.map((pane, i) => {
            const v = i === 1 ? view1 : view0
            const isFocused = i === paneLayout.focusIndex
            const split = paneLayout.panes.length > 1
            const grow = i === 0 ? paneLayout.splitFraction : 1 - paneLayout.splitFraction
            return (
              <Fragment key={pane.id}>
                {i > 0 && (
                  <ResizeHandle
                    ariaLabel="Resize split"
                    onResizeStart={() => {
                      // The handle reports a pointer DELTA, so snapshot both the fraction it started
                      // from and the width that delta is a fraction OF.
                      splitDragRef.current = {
                        fraction: paneLayout.splitFraction,
                        width: panesElRef.current?.clientWidth ?? 0
                      }
                    }}
                    onResize={(dx) => {
                      const { fraction, width } = splitDragRef.current
                      if (width > 0) panes.setSplitFraction(fraction + dx / width)
                    }}
                    onReset={() => panes.setSplitFraction(SPLIT_LIMITS.default)}
                  />
                )}
                <MainPane
                  selectedId={v.id}
                  paneIndex={i}
                  paneFocused={isFocused}
                  style={split ? { flexGrow: grow, flexBasis: 0 } : undefined}
                  onPaneFocus={split ? () => panes.focusPane(i) : undefined}
                  terminalAt={v.terminalAt}
                  onClaimTerminal={() => {
                    if (v.pty) claimTerminal(v.pty.ptyId, i)
                  }}
                  showTabs={tabsEnabled}
                  tabs={tabsByPane[i] ?? []}
                  activeTabIndex={pane.activeIndex}
                  onActivateTab={goToTab}
                  onCloseTab={closeTabsFrom}
                  onCloseOtherTabs={panes.closeOtherTabs}
                  onPromoteTab={panes.promoteTab}
                  canSplitRight={canSplitRightFrom(i)}
                  canMoveToOtherPane={paneLayout.panes.length === 2}
                  onSplitRightTab={splitRightTab}
                  onMoveTabToOtherPane={moveTabToOtherPane}
                  onOpenTabInNewWindow={moveToNewWindow}
                  onMoveTab={moveTabHere}
                  onTabLeftWindow={tabLeftWindow}
                  selectedTabIds={tabSelection.ids}
                  onToggleTabSelect={toggleTabSelected}
                  onExtendTabSelect={extendTabSelection}
                  onMoveTabGroup={moveTabGroupHere}
                  onResolveTabTargets={targetsFor}
                  onShowInfoFor={(id) => showInfo(id, false)}
                  title={v.title}
                  cwd={v.cwd}
                  meta={v.meta}
                  pty={v.pty}
                  view={v.view}
                  theme={themeResolved}
                  focusReq={focusReq}
                  transcript={i === 1 ? transcript1 : transcript0}
                  transcriptLoading={i === 1 ? loading1 : loading0}
                  activePtys={ptysByPane[i] ?? []}
                  pinned={v.id ? pinned.has(v.id) : false}
                  unlinked={v.id ? isUnlinkedId(v.id) : false}
                  onTogglePin={() => {
                    if (v.id) togglePinGated(v.id)
                  }}
                  onResume={() => {
                    if (v.meta) void resume(v.meta, i)
                  }}
                  onShowHistory={() => {
                    if (v.id) setSessionView(v.id, 'transcript')
                  }}
                  onGoLive={() => goLive(i)}
                  onKill={() => {
                    if (v.pty) killSession(v.pty.ptyId)
                  }}
                  onShowInfo={() => {
                    if (v.id) showInfo(v.id, false)
                  }}
                  onEngage={onEngage}
                  onMarkUnread={markUnreadGated}
                  paneRef={i === 1 ? pane1Ref : pane0Ref}
                  // Find belongs to the pane holding the keyboard; the other pane never shows the bar.
                  findOpen={findOpen && isFocused}
                  findFocusReq={findFocusReq}
                  onFindClose={closeFind}
                  onFindActivate={onFindActivate}
                  onFindToggle={toggleFind}
                  markdownCopy={markdownCopy}
                />
              </Fragment>
            )
          })}
        </div>
      </div>
      <SettingsModal
        page={settingsPage}
        onChangePage={setSettingsPage}
        onClose={() => setSettingsPage(null)}
        updates={updates}
        themeMode={themeMode}
        onSetThemeMode={setThemeMode}
        darkIcon={darkIcon.value}
        onSetDarkIcon={darkIcon.set}
        defaultDir={defaultDir}
        onChooseDefaultDir={chooseDefaultDir}
        onClearDefaultDir={clearDefaultDir}
        defaultAgentChoice={defaultAgentChoice}
        defaultAgentDisabled={defaultAgentDisabled}
        onSetDefaultAgentChoice={setDefaultAgentChoice}
        maxLiveSessions={maxLive}
        maxLiveMin={maxLiveMin}
        maxLiveMax={maxLiveMax}
        maxLiveDefault={maxLiveDefault}
        onSetMaxLive={setMaxLive}
        onResetMaxLive={resetMaxLive}
        markdownCopy={markdownCopy}
        onSetMarkdownCopy={setMarkdownCopy}
        tabsEnabled={tabsEnabled}
        onSetTabsEnabled={setTabsEnabled}
      />
      <CapWarningModal capWarning={capWarning} onDismiss={() => setCapWarnDismissed(true)} />
      <ConversationInfoModal
        open={!!infoModal}
        meta={infoMeta}
        pty={infoPty}
        startInEdit={infoModal?.edit ?? false}
        onClose={() => setInfoModal(null)}
        onRename={(t) => {
          if (infoModal) renameConversation(infoModal.sessionId, t)
        }}
      />
      <TooltipLayer />
    </div>
  )
}
