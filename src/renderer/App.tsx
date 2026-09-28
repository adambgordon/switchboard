import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type {
  AgentKind,
  ConversationMeta,
  LiveState,
  PtyState,
  TabOpenMode,
  Transcript
} from '@shared/types'
import { makeTabDragPayload } from '@shared/tabDrag'
import { visibleTabLayout } from '@shared/sessionVisibility'
import { useSessions } from './lib/useSessions'
import { usePtys } from './lib/usePtys'
import { usePins } from './lib/usePins'
import { useRowRank } from './lib/useRowRank'
import { useSidebarPrefs } from './lib/useSidebarPrefs'
import {
  DEFAULT_SIDEBAR_LIMITS,
  buildSidebar,
  freezeFoldersByNewest,
  folderRankSpace,
  rankSpace,
  resumeWrites,
  synthMeta,
  visibleRows,
  enteredFolders,
  withFolders,
  withoutFolders,
  type ActivePlace,
  type SidebarBlock,
  type SidebarModel
} from './lib/sidebarModel'
import { absorbBind, absorbBindFolder, dropWrites } from './lib/rowRank'
import { FOLDER_SEED_TASK, ONCE_TASKS_KEY, parseOnceTasks, withOnceTask } from './lib/onceTasks'
import { bindActions, boundTabAdoption, type PendingBoundTab } from './lib/bindPolicy'
import { deferredResumeAction } from './lib/deferredResume'
import { viewToggleAction } from './lib/viewToggle'
import { useTabLayout } from './lib/useTabLayout'
import {
  canPersistTabWorkspace,
  restoredWorkspaceApplied,
  tabPersistAction
} from './lib/tabPersistPolicy'
import { PANE_LIMITS, useLayout } from './lib/useLayout'
import { usePaneLayout } from './lib/usePaneLayout'
import { useTabsEnabled } from './lib/useTabsEnabled'
import {
  SPLIT_LIMITS,
  activeTabId,
  canPlaceTabsToSide,
  canSplitActiveTab,
  effectiveTabOpenMode,
  locateTab,
  openSessionIds,
  paneActiveId,
  snapshotPaneLayout,
  stepTab
} from './lib/paneModel'
import {
  chooserTabId,
  isChooserTab,
  newConversationTarget,
  strayChoosers,
  type ChooserMemory
} from './lib/chooserTab'
import { emptyAfterStop, endedStops } from './lib/stopClose'
import type { SidePlace } from './lib/conversationMenu'
import {
  NO_SELECTION,
  actionTargets,
  keyboardCloseTargets,
  extendSelection,
  pruneSelection,
  retargetSelection,
  selectOnly,
  shouldClearSelectionOnPointerDown,
  shouldClearSelectionOnWindowBlur,
  toggleSelected,
  type TabSelection
} from './lib/tabSelection'
import { nextPtyHomes } from './lib/ptyHome'
import { useMarkdownCopy } from './lib/useMarkdownCopy'
import { chooserDirs, chooserPreselect, type ChooserFolder } from './lib/chooserDirs'
import { useNewConvoDefaultAgent } from './lib/useNewConvoDefaultAgent'
import { useAgentAvailability } from './lib/useAgentAvailability'
import { useMaxLiveSessions } from './lib/useMaxLiveSessions'
import { useSeen } from './lib/useSeen'
import { useWindowFocus } from './lib/useWindowFocus'
import { useTranscript } from './lib/useTranscript'
import { useAppNavigation } from './lib/useAppNavigation'
import type { ConversationView, NavigationCommand } from '@shared/navigation'
import { useTheme } from './lib/useTheme'
import { useDotColor } from './lib/useDotColor'
import { applyDotColor } from './lib/themeDom'
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
import { rowTipMeta, rowTipPreview, rowTipTitle } from './lib/rowTip'
import TitleBar from './components/TitleBar'
import MainPane from './components/MainPane'
import type { TabConversationCommand, TabDescriptor } from './components/TabStrip'
import Sidebar from './components/Sidebar'
import ResizeHandle from './components/ResizeHandle'
import SettingsModal from './components/SettingsModal'
import ConversationInfoModal from './components/ConversationInfoModal'
import TooltipLayer from './components/TooltipLayer'
import AppVeil from './components/AppVeil'
import type { TranscriptScrollState } from './components/TranscriptView'
import TerminalDeck from './components/TerminalDeck'
import ChooserView from './components/ChooserView'

const NO_FOLDERS: readonly ChooserFolder[] = []

export default function App() {
  const { groups, hiddenSessionIds, loading } = useSessions()
  const hiddenSessionIdsRef = useRef(hiddenSessionIds)
  hiddenSessionIdsRef.current = hiddenSessionIds
  const ptys = usePtys()
  const { pinned, order: pinnedOrder, toggle: togglePin, move: movePin } = usePins()
  // A nonce bumped on each drag-reorder commit, folded into the rail's FLIP controlSig so the commit
  // settles instantly (the drag already showed the arrangement); pin/unpin toggles don't bump it, so
  // they still glide.
  const [reorderTick, setReorderTick] = useState(0)
  // Row and folder order: sparse overrides over each row's seed, shared by every window. Written only
  // by a drop, a Resume and an initial bind — never by a render — see rowRank.
  const { rows: rowRanks, folders: folderRanks, mutateRows, mutateFolders } = useRowRank()
  const {
    mode: sidebarMode,
    setMode: setSidebarMode,
    density: railDensity,
    setDensity: setRailDensity,
    collapsed: folderCollapse,
    setFolderCollapsed,
    setFoldersCollapsed
  } = useSidebarPrefs()
  // The last rendered sidebar, for handlers that write positions: a drop, a Resume and a bind all
  // need to know where rows are NOW, and must not re-subscribe on every render to find out.
  const sidebarModelRef = useRef<SidebarModel | null>(null)
  const { seen, unread, markSeen, markUnread, markRead, rekey: rekeySeen } = useSeen()
  const { enabled: markdownCopy, setEnabled: setMarkdownCopy } = useMarkdownCopy()
  const {
    agent: defaultAgent,
    enabled: defaultAgentEnabled,
    setAgent: setDefaultAgent,
    setEnabled: setDefaultAgentEnabled
  } = useNewConvoDefaultAgent()
  const agents = useAgentAvailability()
  // The agent a new-conversation chooser opens on — sticky within a session (the last one picked or
  // started), so the next chooser remembers your choice. Ephemeral on purpose: the persisted default-agent
  // preference is the cross-restart mechanism; this is just stickiness.
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
  const { color: dotColor, setColor: setDotColor } = useDotColor()
  // The dot color is placed relative to the surface it sits on, so a theme flip re-derives it just
  // as a new choice does. main.tsx does the first apply, before render; this owns every one after.
  useEffect(() => {
    applyDotColor(dotColor, themeResolved)
  }, [dotColor, themeResolved])
  // Stable identity: Preferences restores the stored color from an effect keyed on this, which a
  // new function each render would turn into a re-apply on every render.
  const previewDotColor = useCallback(
    (hex: string | null) => applyDotColor(hex, themeResolved),
    [themeResolved]
  )
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
  const windowInit = window.sbWindow ?? {
    sessionIds: [],
    activeSessionId: null,
    restoredTabs: null,
    primary: true,
    collapseRail: false
  }
  const detached = !windowInit.primary
  const {
    paneWidth,
    paneCollapsed,
    setPaneWidth,
    togglePane,
    resetPane
  } = useLayout({ collapseRail: windowInit.collapseRail, persist: !detached })
  const dragStartRef = useRef(0)
  const bodyElRef = useRef<HTMLDivElement>(null)
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
  const { tabLayout, setTabLayout } = useTabLayout()
  const panes = usePaneLayout(tabsEnabled ? windowInit.restoredTabs : null, hiddenSessionIds)
  const { layout: paneLayout } = panes
  const [tabWorkspaceReady, setTabWorkspaceReady] = useState(
    () => tabsEnabled && !windowInit.restoredTabs
  )
  const pendingWorkspaceKeyRef = useRef<string | null>(null)
  const pendingBoundClaimsRef = useRef(new Map<string, PendingBoundTab>())
  // THE selection: the active tab of the focused pane. Derived, never stored twice. `selectedId` is the
  // CONVERSATION selected — null while the tab is a new-conversation chooser, which holds none — and is
  // what everything conversation-keyed reads; only focus and tab bookkeeping read the tab itself.
  const selectedTabId = panes.selectedId
  const selectedId = selectedTabId !== null && isChooserTab(selectedTabId) ? null : selectedTabId
  const selectedTabIdRef = useRef(selectedTabId)
  selectedTabIdRef.current = selectedTabId

  const navigationApplyRef = useRef<((command: NavigationCommand) => void) | null>(null)
  const {
    beginVisit,
    go: goHistory,
    rekey: rekeyPendingNavigation,
    report: reportNavigation
  } = useAppNavigation(navigationApplyRef, hiddenSessionIds)
  const focusPane = useCallback((index: number) => {
    beginVisit()
    panes.focusPane(index)
  }, [beginVisit, panes.focusPane])
  // Read by the onPtyBound listener, which must not re-subscribe on every selection change.
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  // Session-targeted focus request, bumped whenever you land on a conversation (a click, ⌥⌘↑/↓
  // switch, Enter, resume, new, go-live) — the main pane always takes the keyboard. A per-session
  // focusReq lets MainPane route focus to the right surface (a live terminal, else the Formatted
  // transcript) only for the selected conversation.
  const [focusReq, setFocusReq] = useState<{ sessionId: string; n: number } | null>(null)
  const keepTabFocusRef = useRef(false)
  const requestFocus = useCallback(
    (sessionId: string) => setFocusReq((r) => ({ sessionId, n: (r?.n ?? 0) + 1 })),
    []
  )
  // Per-conversation view memory (Formatted vs Terminal). The choice sticks per
  // session, so leaving and returning to a live conversation restores its view.
  const [viewBySession, setViewBySession] = useState<Record<string, ConversationView>>({})
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  // Per open new-conversation chooser tab: the folder it opens on — fixed at open, so the list does not
  // reshuffle as the focused conversation changes behind it — and the tab it was opened from, where Esc
  // returns, and `aim`, bumped each time a folder's pencil re-aims it. Ids are minted per window and never
  // reused.
  const [choosers, setChoosers] = useState<
    Readonly<Record<string, { preselect: string | null; from: string | null; aim: number }>>
  >({})
  const choosersRef = useRef(choosers)
  choosersRef.current = choosers
  const nextChooserRef = useRef(1)
  // What each chooser remembers across its view remounting — see ChooserMemory.
  const chooserMemoryRef = useRef(new Map<string, ChooserMemory>())
  const [settingsPage, setSettingsPage] = useState<
    'appearance' | 'application' | 'beta' | 'shortcuts' | 'faq' | null
  >(null)
  // Conversation-info modal target: which session, and whether to open straight into title-edit vs
  // view (both the pane title and the right-click "Session details…" open in view). Null when closed.
  const [infoModal, setInfoModal] = useState<{ sessionId: string; edit: boolean } | null>(null)
  useLayoutEffect(() => {
    if (infoModal && hiddenSessionIds.has(infoModal.sessionId)) setInfoModal(null)
  }, [infoModal, hiddenSessionIds])
  const overlayOpenRef = useRef(false)
  // Extra rows revealed past a group's cap via "Show more", per group key (ephemeral — resets on reload).
  const [revealed, setRevealed] = useState<Record<string, number>>({})
  // Folders the active conversation has been in this session. They stay open after focus moves on:
  // collapsing one the moment you click elsewhere would slide every row below it under the pointer.
  // Only a chevron click closes one again. Never persisted.
  const [navExpanded, setNavExpanded] = useState<ReadonlySet<string>>(() => new Set())
  // Folders collapsed by hand while a conversation in them was on screen — the only way that folder
  // closes, since otherwise being active opens it. Navigation into the folder clears its entry.
  const [activeCollapsed, setActiveCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  // Find-in-conversation (main pane). App owns the open/close toggle — ⌘F opens it when focus is
  // in the main pane, Esc closes it; the query + match state live in MainPane. `paneRef` lets the
  // ⌘F handler tell whether focus is physically inside the main pane vs the rail.
  // One ref per pane. `inMain` is true when focus is inside EITHER, which is what routes ⌘F and keeps
  // the main area owning the keyboard; the focused pane (paneLayout.focusIndex) is what decides which
  // one acts on it.
  const pane0Ref = useRef<HTMLElement>(null)
  const pane1Ref = useRef<HTMLElement>(null)
  const [terminalHosts, setTerminalHosts] = useState<Array<HTMLElement | null>>([null, null])
  const setTerminalHost = useCallback((index: number, node: HTMLElement | null): void => {
    setTerminalHosts((prev) => {
      if (prev[index] === node) return prev
      const next = [...prev]
      next[index] = node
      return next
    })
  }, [])
  const setTerminalHost0 = useCallback((node: HTMLDivElement | null) => setTerminalHost(0, node), [setTerminalHost])
  const setTerminalHost1 = useCallback((node: HTMLDivElement | null) => setTerminalHost(1, node), [setTerminalHost])
  const transcriptCacheRef = useRef(new Map<string, Transcript | null>())
  const transcriptScrollStateRef = useRef(new Map<string, TranscriptScrollState>())
  const [findOpen, setFindOpen] = useState(false)
  // Bumped on every ⌘F while focus is in the main pane, so pressing ⌘F again (after clicking into
  // the transcript) re-focuses the find input even when the bar is already open. Threaded down to
  // TranscriptSearch, which focuses + selects whenever it changes.
  const [findFocusReq, setFindFocusReq] = useState(0)
  // Find can stay open while tabs change. Remember every live terminal it temporarily moved to
  // Formatted so closing restores all of them, not only whichever tab was visited last.
  const findPriorTerminalIdsRef = useRef(new Set<string>())

  // Begin buffering PTY output immediately, before any session is spawned.
  useEffect(() => {
    initPtyStream()
  }, [])

  // Keep handoff state only for terminals this window owns. A former owner receives a fresh snapshot if
  // it claims the terminal again, so retaining its stale copy would only multiply memory across windows.
  useEffect(() => {
    retainOnly(new Set(ptys.active.filter((p) => p.ownedHere).map((p) => p.ptyId)))
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
  const [pendingResumeId, setPendingResumeId] = useState<string | null>(null)

  // Several tabs acted on as one. Kept beside the layout rather than inside it: a selection is about
  // what the user has picked out, not about what exists, and folding it into the reducer would make
  // every open and close have to say something about it.
  const [tabSelection, setTabSelection] = useState<TabSelection>(NO_SELECTION)
  const tabSelectionRef = useRef(tabSelection)
  tabSelectionRef.current = tabSelection
  const hasTabSelection = tabSelection.ids.size > 0
  useEffect(() => {
    if (!hasTabSelection) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      const tabId = target?.closest<HTMLElement>('.sb-tab')?.dataset.sessionId ?? null
      if (
        shouldClearSelectionOnPointerDown(
          tabSelectionRef.current,
          tabId,
          tabId !== null && (event.metaKey || event.shiftKey)
        )
      ) {
        setTabSelection(NO_SELECTION)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [hasTabSelection])
  useEffect(() => {
    if (shouldClearSelectionOnWindowBlur(tabSelectionRef.current, focused)) {
      setTabSelection(NO_SELECTION)
    }
  }, [focused])
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
  //
  // A chooser tab is never part of a selection: every group action — a move to another window above all
  // — carries conversations, and a chooser is not one. It is left out of both the gesture and the run.
  const selectableActive = (pane: number): string | null => {
    const p = paneLayoutRef.current.panes[pane]
    const id = p ? paneActiveId(p) : null
    return id !== null && isChooserTab(id) ? null : id
  }
  const toggleTabSelected = useCallback((pane: number, sessionId: string) => {
    if (isChooserTab(sessionId)) return
    const active = selectableActive(pane)
    setTabSelection((s) => toggleSelected(s, pane, active, sessionId))
  }, [])
  const extendTabSelection = useCallback((pane: number, sessionId: string) => {
    if (isChooserTab(sessionId)) return
    const p = paneLayoutRef.current.panes[pane]
    const order = p?.tabs.map((t) => t.sessionId).filter((id) => !isChooserTab(id)) ?? []
    // The active tab is the fallback anchor, so a first ⇧-click takes the run from where the user is.
    const active = selectableActive(pane)
    setTabSelection((s) => extendSelection(s, pane, order, sessionId, active))
  }, [])

  // What a command invoked on ONE tab should actually act on: the group when that tab belongs to one,
  // and just that tab otherwise. Every group-capable action goes through this, so "acts on the
  // selection" is one rule rather than a condition repeated at each of them.
  const targetsFor = useCallback(
    (pane: number, sessionId: string): string[] =>
      actionTargets(tabSelectionRef.current, pane, sessionId),
    []
  )

  // Controls invoked on a tab close its group only when that tab belongs to it. Keyboard close
  // resolves the focused group independently, since the active tab can be outside the selection.
  const closeTabsFrom = useCallback(
    (pane: number, index: number) => {
      beginVisit()
      const id = paneLayoutRef.current.panes[pane]?.tabs[index]?.sessionId
      if (!id) return
      const ids = targetsFor(pane, id)
      if (ids.length > 1) panes.closeTabs(ids)
      else panes.closeTab(pane, index)
    },
    [panes.closeTab, panes.closeTabs, targetsFor, beginVisit]
  )
  const tabsEnabledRef = useRef(tabsEnabled)
  tabsEnabledRef.current = tabsEnabled

  // A detached window opens straight onto the tab group it was created for. Runs once; the
  // conversation index has not necessarily loaded yet, which is fine, because tabs hold ids and their
  // titles fill in when it arrives.
  const openedInitialRef = useRef(false)
  useEffect(() => {
    const targets = windowInit.sessionIds
    if (targets.length === 0 || openedInitialRef.current) return
    openedInitialRef.current = true
    const activeSessionId = windowInit.activeSessionId ?? targets[0]
    panes.openTabs(targets, activeSessionId)
    if (targets.length > 1) {
      setTabSelection({ pane: 0, ids: new Set(targets), anchor: activeSessionId })
    }
  }, [panes.openTabs])

  // ⌘W arrives as a push from the File menu, not a keydown: a menu accelerator is consumed by the app
  // and the key event never reaches the page. Close the focused pane's active tab; with none — no tabs
  // open, or the feature switched off — close the window instead, so the chord still does what every
  // other macOS app does with it.
  useEffect(() => {
    const off = window.api.onMenuCloseTab(() => {
      if (overlayOpenRef.current) return
      beginVisit()
      const l = paneLayoutRef.current
      const active = paneActiveId(l.panes[l.focusIndex])
      const ids = keyboardCloseTargets(tabSelectionRef.current, l.focusIndex, active)
      // A chooser closes like a tab even with tabs off, where it is the one thing ⌘W should not
      // mistake for the whole window: it is a question on top of what was showing.
      const closesTab = tabsEnabledRef.current || (active !== null && isChooserTab(active))
      if (closesTab && ids.length > 0) panes.closeTabs(ids)
      else window.api.closeWindow()
    })
    return off
  }, [panes.closeTabs, beginVisit])

  // A Codex PTY's sessionId changed — an initial bind off a placeholder, or a correction between two
  // real conversations. The two need OPPOSITE handling of session-keyed state, and getting it wrong
  // destroys durable data, so the decision lives in pure, mutation-checked `bindActions` and this
  // effect is only the wiring. See bindPolicy.ts and PtyBindKind.
  useEffect(() => {
    let alive = true
    const latestBinds = new Map<string, object>()
    const cancelPending = (ptyId: string): void => {
      const pending = pendingBoundClaimsRef.current.get(ptyId)
      if (pending) window.api.cancelBoundTab(pending.token)
      pendingBoundClaimsRef.current.delete(ptyId)
    }
    const offExit = window.api.onPtyExit((ptyId) => {
      latestBinds.delete(ptyId)
      cancelPending(ptyId)
    })
    const off = window.api.onPtyBound((ptyId, oldId, newId, kind, ownedHere, adoptionToken) => {
      cancelPending(ptyId)
      if (kind === 'initial') rekeyPendingNavigation(oldId, newId)
      const ev = { oldId, newId, kind }
      latestBinds.set(ptyId, ev)
      const act = bindActions(ev, selectedIdRef.current, ownedHere)
      // Read before `active-changed` renders the new id: `bindCodex` emits `bound` first, so the last
      // rendered model still holds the placeholder's row, its rank and its folder.
      const place = act.retargetRowOrder ? sidebarModelRef.current?.rows.get(oldId) : undefined
      if (place) {
        mutateRows((stored) => absorbBind(stored, place.rank, oldId, newId))
        const folder = sidebarModelRef.current?.folders.get(place.root)
        if (folder) mutateFolders((stored) => absorbBindFolder(stored, place.root, folder, place.seed))
      }
      const apply = (): void => {
        if (act.view !== 'none' && findPriorTerminalIdsRef.current.delete(oldId)) {
          findPriorTerminalIdsRef.current.add(newId)
        }
        if (act.rekeySeen) rekeySeen(oldId, newId)
        // Tabs are session-keyed too. `rekey` rewrites every tab holding a placeholder that is ceasing
        // to exist; `retarget` moves only the tab the user is standing on, leaving inactive tabs on the
        // old id alone — that conversation is still real, only the terminal moved.
        if (act.tabs === 'rekey') panes.rekeyTabs(oldId, newId)
        else if (act.tabs === 'retarget') panes.retargetTabs(oldId, newId)
        if (act.tabSelection !== 'none') {
          setTabSelection((selection) => retargetSelection(selection, oldId, newId))
        }
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
      }

      if (kind === 'correction' && act.tabs === 'retarget') {
        void window.api
          .reserveBoundTab(ptyId, oldId, newId)
          .then((token) => {
            if (!token) return
            if (!alive || latestBinds.get(ptyId) !== ev || selectedIdRef.current !== oldId) {
              window.api.cancelBoundTab(token)
              return
            }
            pendingBoundClaimsRef.current.set(ptyId, { token, ...ev })
            apply()
          })
          .catch(() => {})
      } else {
        if (adoptionToken) {
          if (locateTab(paneLayoutRef.current, oldId)) {
            pendingBoundClaimsRef.current.set(ptyId, { token: adoptionToken, ...ev })
          } else {
            window.api.cancelBoundTab(adoptionToken)
          }
        }
        apply()
      }
    })
    return () => {
      alive = false
      off()
      offExit()
      for (const ptyId of pendingBoundClaimsRef.current.keys()) cancelPending(ptyId)
    }
  }, [
    rekeyPendingNavigation,
    rekeySeen,
    requestFocus,
    mutateRows,
    mutateFolders,
    panes.rekeyTabs,
    panes.retargetTabs
  ])

  // Initial binds may adopt several inactive tabs in one commit. Corrections still require the app
  // selection to follow. Read the committed layout before normal membership reports reach main.
  useLayoutEffect(() => {
    for (const [ptyId, pending] of pendingBoundClaimsRef.current) {
      const action = boundTabAdoption(pending, paneLayout)
      if (action === 'wait') continue
      pendingBoundClaimsRef.current.delete(ptyId)
      if (action === 'commit') window.api.commitBoundTab(pending.token)
      else window.api.cancelBoundTab(pending.token)
    }
  })

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

  // A selection change normally hands the conversation surface the keyboard. Roving through the tab
  // strip is the one exception: keep focus on its newly-active tab so another arrow can continue.
  // Keyed on the TAB, so landing on a chooser hands its filter the keyboard too.
  useEffect(() => {
    if (!selectedTabId) return
    if (keepTabFocusRef.current) {
      keepTabFocusRef.current = false
      return
    }
    requestFocus(selectedTabId)
  }, [selectedTabId, requestFocus])

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
  // Which pane each live terminal is mounted in. A window holds one stable xterm per terminal in the
  // window-level deck, so a live tab moving panes only changes its portal host.
  // With no local tab the home stays sticky, so focus changes do not remount hidden terminals.
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
    const tabId = pane ? paneActiveId(pane) : null
    // A chooser shows no conversation: everything below resolves as for an empty pane.
    const chooser = tabId !== null && isChooserTab(tabId) ? tabId : null
    const id = chooser ? null : tabId
    const meta = id ? metaById.get(id) ?? null : null
    const pty = id ? ptys.bySession.get(id) ?? null : null
    // A terminal renders here only if this WINDOW owns it (main decides, one owner app-wide) and this
    // PANE is its home within the window. The two are independent gates: cross-window ownership moves
    // only on an explicit claim, while the pane home follows the tab automatically.
    const ownsTerminal = !!pty && pty.ownedHere && ptyHome[pty.ptyId] === index
    const terminalAt: 'here' | 'other-pane' | 'claimable' | null = !pty
      ? null
      : ownsTerminal
        ? 'here'
        : pty.ownedHere
          ? 'other-pane'
          : 'claimable'
    const requested: ConversationView = id
      ? viewBySession[id] ?? (pty ? 'terminal' : 'transcript')
      : 'transcript'
    return {
      pane,
      id,
      chooser,
      meta,
      pty,
      terminalAt,
      view: (requested === 'terminal' && ownsTerminal ? 'terminal' : 'transcript') as ConversationView,
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
    view0.meta ? `${view0.meta.mtime}:${view0.meta.sizeBytes}` : 'unindexed',
    view0.view === 'transcript',
    transcriptCacheRef.current
  )
  const { transcript: transcript1, loading: loading1 } = useTranscript(
    view1.id,
    view1.meta ? `${view1.meta.mtime}:${view1.meta.sizeBytes}` : 'unindexed',
    view1.view === 'transcript',
    transcriptCacheRef.current
  )
  const focusedView = paneLayout.focusIndex === 1 ? view1 : view0
  useLayoutEffect(() => {
    const id = focusedView.id
    const view = id && findPriorTerminalIdsRef.current.has(id) ? 'terminal' : focusedView.view
    reportNavigation(id ? { sessionId: id, view } : null, focusedView.terminalAt === 'here')
  })

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

  const ownedPtys = useMemo(() => ptys.active.filter((p) => p.ownedHere), [ptys.active])
  const visiblePtyIds = [
    view0.view === 'terminal' && view0.terminalAt === 'here' ? view0.pty?.ptyId ?? null : null,
    view1.view === 'terminal' && view1.terminalAt === 'here' ? view1.pty?.ptyId ?? null : null
  ]
  // Tell main which terminals are actually on screen here, so the live-session cap never reclaims one
  // being looked at. Only a RENDERED terminal counts: a pane showing the Formatted view is unaffected
  // by its terminal going away, so protecting it would pin sessions for no visible benefit. Keyed on
  // the joined ids rather than the array, which is rebuilt every render.
  const visiblePtySig = visiblePtyIds.join('|')
  useEffect(() => {
    window.api.reportVisiblePtys(visiblePtyIds.filter((id): id is string => id !== null))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- visiblePtyIds folded into the signature
  }, [visiblePtySig])

  // THE rail: every row, its folder, its order, and which rows render. One pure build, read by the
  // rail AND by keyboard navigation, so the two cannot disagree about what is on screen.
  const sidebarModel = useMemo(
    () =>
      buildSidebar({
        mode: sidebarMode,
        groups,
        ptys: ptys.active,
        pinned: pinnedOrder,
        hidden: hiddenSessionIds,
        rowRanks,
        folderRanks,
        liveState: liveStateFor,
        active: visibleIds,
        collapsed: folderCollapse,
        navExpanded,
        activeCollapsed,
        revealed,
        search: matchIds,
        limits: DEFAULT_SIDEBAR_LIMITS
      }),
    [
      sidebarMode,
      groups,
      ptys.active,
      pinnedOrder,
      hiddenSessionIds,
      rowRanks,
      folderRanks,
      liveStateFor,
      visibleIds,
      folderCollapse,
      navExpanded,
      activeCollapsed,
      revealed,
      matchIds
    ]
  )
  sidebarModelRef.current = sidebarModel

  // Once per profile, ever: the first time this rail runs, freeze the folders newest-first. Waits for a
  // load with indexed conversations — the index arrives whole, and a failed one arrives empty, which
  // must not count as "done" even while a live terminal gives the rail a row of its own. A layout effect, so the frozen order is what first paints. The marker is folded into a
  // fresh read, and every window checks it first, so a later window finds it done and skips.
  const catalogReady = !loading && groups.some((g) => g.conversations.length > 0)
  useLayoutEffect(() => {
    if (!catalogReady) return
    let done: string[]
    try {
      done = parseOnceTasks(localStorage.getItem(ONCE_TASKS_KEY))
    } catch {
      return
    }
    if (done.includes(FOLDER_SEED_TASK)) return
    const model = sidebarModelRef.current
    if (!model) return
    mutateFolders((stored) => freezeFoldersByNewest(model, stored))
    try {
      localStorage.setItem(ONCE_TASKS_KEY, JSON.stringify(withOnceTask(done, FOLDER_SEED_TASK)))
    } catch {
      /* storage unavailable — the freeze simply runs again next launch */
    }
  }, [catalogReady, mutateFolders])

  // Navigation entering a folder opens it: remembered so it stays open once focus moves on, and any
  // collapse made while it was active is forgotten. Keyed on the (conversation, folder) pairs, not the
  // model, which is rebuilt on every liveness change. A layout effect, so a conversation opened in a
  // folder the user collapsed never paints with its folder shut.
  const activePlacesKey = JSON.stringify(
    [...visibleIds].flatMap((id): ActivePlace[] => {
      const root = sidebarModel.rows.get(id)?.root
      return root === undefined ? [] : [[id, root]]
    })
  )
  const activePlacesRef = useRef<ActivePlace[]>([])
  useLayoutEffect(() => {
    const places = JSON.parse(activePlacesKey) as ActivePlace[]
    const entered = enteredFolders(activePlacesRef.current, places)
    activePlacesRef.current = places
    if (entered.length === 0) return
    setNavExpanded((prev) => withFolders(prev, entered))
    setActiveCollapsed((prev) => withoutFolders(prev, entered))
  }, [activePlacesKey])

  overlayOpenRef.current = settingsPage !== null || infoModal !== null

  // "This row stands for no conversation" (see rowIdentity), by id — the ONE place that resolution
  // lives. Every consumer of the gate routes through here rather than re-deriving it: an unlinked
  // row must not persist read state or a pin under an id that may never bind, and a gate copied per
  // call site is how one copy ends up missing (which is what put a stranger's liveness dot on a
  // background-agent row).
  //
  // A chooser tab stands for no conversation either, so it answers here too — which is what keeps it out
  // of read marks and pins, and its tab menu free of conversation items.
  const isUnlinkedId = useCallback(
    (id: string): boolean => {
      if (isChooserTab(id)) return true
      const pty = ptys.bySession.get(id) ?? null
      return !!pty && isUnlinkedRow(pty, metaById.get(id) ?? synthMeta(pty))
    },
    [ptys.bySession, metaById]
  )

  // A tab's when-and-where line, from the same folder and label the rail row uses. A conversation the
  // rail does not hold (hidden) falls back to its terminal's project, else its own directory.
  const tabTipMeta = useCallback(
    (meta: ConversationMeta, pty: PtyState | null): string => {
      const root = sidebarModel.rows.get(meta.sessionId)?.root ?? pty?.projectRoot ?? meta.cwd
      return rowTipMeta(sidebarModel.labels.get(root) ?? basename(root), meta.cwd, root, {
        background: meta.agent === 'claude' && meta.sessionKind === 'bg',
        elsewhere: false
      })
    },
    [sidebarModel]
  )

  // Per-pane tab descriptors for the strips. Resolved here rather than in TabStrip so the strip stays
  // presentational, and so a tab's title comes from the SAME derivation the rail row and the pane
  // header use — a tab must not name one thing while the row beside it names another.
  const tabsByPane = useMemo<TabDescriptor[][]>(
    () =>
      paneLayout.panes.map((p) =>
        p.tabs.map((tab) => {
          if (isChooserTab(tab.sessionId)) {
            return {
              sessionId: tab.sessionId,
              title: 'New conversation',
              subtitle: null,
              lastActiveAt: null,
              tipMeta: null,
              preview: tab.preview,
              dot: null,
              unlinked: true,
              running: false,
              pinned: false,
              unread: false
            }
          }
          const pty = ptys.bySession.get(tab.sessionId) ?? null
          const meta = metaById.get(tab.sessionId) ?? (pty ? synthMeta(pty) : null)
          const state = meta ? liveStateFor(pty, meta, tab.sessionId) : null
          return {
            sessionId: tab.sessionId,
            title: rowTipTitle(pty && meta ? displayTitleForRow(pty, meta) : meta?.title ?? 'Conversation'),
            // The hover carries the rail row's preview line, since a tab truncates far harder than a
            // row does. A row falls back to a "No preview" placeholder to hold its height; a tooltip
            // has no height to hold, so absent a real preview the second line is simply omitted
            // rather than spending it saying there is nothing to say.
            subtitle: rowTipPreview(
              meta && pty && isParkedOnlyRow(pty, meta)
                ? 'Terminal only — work is in a background agent'
                : meta?.preview ?? null
            ),
            // The same when-and-where line as the rail row. A tab is in this window by definition, so
            // it never says "In another window".
            lastActiveAt: meta ? meta.lastActivityAt ?? meta.mtime : null,
            tipMeta: meta ? tabTipMeta(meta, pty) : null,
            preview: tab.preview,
            // Null meta implies null pty (meta falls back to the pty's stand-in whenever one exists),
            // so this resolves to "no dot" for exactly the sessions that have no state to report.
            dot: meta ? liveDotClass(pty, meta, state) : null,
            unlinked: isUnlinkedId(tab.sessionId),
            running: !!pty,
            pinned: pinned.has(tab.sessionId),
            // What the rail row's menu calls unread, so the two menus offer the same toggle.
            unread: !!pty && (state === 'awaiting' || state === 'asking')
          }
        })
      ),
    [paneLayout.panes, ptys.bySession, metaById, isUnlinkedId, liveStateFor, tabTipMeta, pinned]
  )

  // Activating a tab is a landing like any other: it marks the conversation read and hands the pane
  // the keyboard. The history stop is recorded by the selection effect, not here.
  const goToTab = useCallback(
    (pane: number, index: number, focusSurface = true) => {
      beginVisit()
      const id = paneLayout.panes[pane]?.tabs[index]?.sessionId
      if (!id) return
      // A plain click means "just this one", so it is also the way out of a multi-selection.
      setTabSelection(selectOnly())
      if (!focusSurface && id !== selectedTabIdRef.current) keepTabFocusRef.current = true
      panes.activateTab(pane, index)
      if (!isUnlinkedId(id)) markRead(id)
      if (focusSurface) requestFocus(id)
    },
    [paneLayout.panes, panes.activateTab, isUnlinkedId, markRead, requestFocus, beginVisit]
  )


  const selectedMeta = focusedView.meta
  const selectedPty = focusedView.pty
  const effectiveView = focusedView.view
  // An unlinked row shows no read state, so it must not persist one either — see rowIdentity.
  const view0Unlinked = view0.id ? isUnlinkedId(view0.id) : false
  const view1Unlinked = view1.id ? isUnlinkedId(view1.id) : false

  const view0InputRequestedAt = view0.pty
    ? currentInputRequestedAt(view0.meta ?? synthMeta(view0.pty), view0.pty.inputRequestedAt)
    : null
  const view1InputRequestedAt = view1.pty
    ? currentInputRequestedAt(view1.meta ?? synthMeta(view1.pty), view1.pty.inputRequestedAt)
    : null

  // Visible conversations advance their seen timestamp independently. A manual unread override is
  // cleared only by an explicit landing or genuine engagement in that specific pane.
  useEffect(() => {
    if (view0.id && focused && !view0Unlinked) markSeen(view0.id, Date.now())
  }, [
    view0.id,
    focused,
    view0Unlinked,
    view0.meta?.turnEndedAt,
    view0InputRequestedAt,
    markSeen
  ])
  useEffect(() => {
    if (view1.id && focused && !view1Unlinked) markSeen(view1.id, Date.now())
  }, [view1.id, focused, view1Unlinked, view1.meta?.turnEndedAt, view1InputRequestedAt, markSeen])

  // Arrow-key order follows what's actually visible — the model the rail renders — so nav never lands
  // on a hidden row.
  const orderedIds = useMemo(() => visibleRows(sidebarModel).map((r) => r.sessionId), [sidebarModel])
  // Each pane's chooser list, computed only while that pane shows a chooser: the list is otherwise
  // unused, and `groups` changes on every index pass of a live session.
  const preselect0 = view0.chooser ? choosers[view0.chooser]?.preselect ?? null : null
  const preselect1 = view1.chooser ? choosers[view1.chooser]?.preselect ?? null : null
  const showsChooser0 = view0.chooser !== null
  const showsChooser1 = view1.chooser !== null
  const folders0 = useMemo(
    () => (showsChooser0 ? chooserDirs(groups, preselect0) : NO_FOLDERS),
    [showsChooser0, groups, preselect0]
  )
  const folders1 = useMemo(
    () => (showsChooser1 ? chooserDirs(groups, preselect1) : NO_FOLDERS),
    [showsChooser1, groups, preselect1]
  )
  const metaByIdRef = useRef(metaById)
  metaByIdRef.current = metaById

  // Agent axis for "new conversation". `availableAgents` are the launchable CLIs: the chooser's agent
  // choice, and each folder header's logos.
  const availableAgents = useMemo<AgentKind[]>(
    () => (['claude', 'codex'] as AgentKind[]).filter((a) => agents[a]),
    [agents]
  )
  // Which agent a chooser opens on (and starts with when it shows no choice).
  const chooserAgent = useMemo<AgentKind>(() => {
    // An explicit, enabled default agent wins over the sticky last pick; otherwise the chooser remembers
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
  const setSessionView = useCallback((id: string, v: ConversationView) => {
    setViewBySession((prev) => (prev[id] === v ? prev : { ...prev, [id]: v }))
  }, [])

  const closeFind = useCallback(() => {
    setFindOpen(false)
    const prior = [...findPriorTerminalIdsRef.current]
    findPriorTerminalIdsRef.current.clear()
    for (const sessionId of prior) setSessionView(sessionId, 'terminal')
  }, [setSessionView])

  const chooseSessionView = useCallback((id: string, view: ConversationView) => {
    beginVisit({ sessionId: id, view })
    if (view === 'terminal') closeFind()
    findPriorTerminalIdsRef.current.delete(id)
    setSessionView(id, view)
  }, [beginVisit, closeFind, setSessionView])

  navigationApplyRef.current = (command) => {
    if (command.kind === 'replay') closeFind()
    panes.openTab(command.sessionId, effectiveTabOpenMode(tabsEnabledRef.current, command.mode))
    if (command.view !== null) setSessionView(command.sessionId, command.view)
    requestFocus(command.sessionId)
  }

  /**
   * Open a conversation from a local user action. Main-directed reveals and history playback use
   * the tagged activation path above.
   *
   * Both paths apply effectiveTabOpenMode: with tabs off, opens replace the single preview in place.
   *
   * `persistent` is for landings that ACT on a conversation rather than peek at it — Resume, New, and
   * ⏎ into a live terminal. Acting on it is what makes a tab stick, the same way editing a file does
   * in an editor.
   */
  const land = useCallback(
    (id: string, mode: TabOpenMode, opts?: { pane?: number; focus?: boolean }) => {
      if (hiddenSessionIdsRef.current.has(id)) return
      beginVisit()
      // One conversation, one tab — across windows as well as across panes. Within this window the
      // reducer handles it; another window's tab is only knowable through main, so it is decided here.
      // The rule matches the reducer's exactly: an implicit open reveals the tab where it is, an
      // explicit placement takes it. Read from a ref and answered synchronously — a round trip before
      // opening a tab would put main's latency on the most-travelled path in the app.
      if (openElsewhereRef.current.has(id) && !locateTab(paneLayoutRef.current, id)) {
        if (opts?.pane === undefined) {
          window.api.revealConversation(id, effectiveTabOpenMode(tabsEnabledRef.current, mode))
          return
        }
        window.api.claimConversation(id)
      }
      panes.openTab(id, effectiveTabOpenMode(tabsEnabledRef.current, mode), opts)
    },
    [panes.openTab, beginVisit]
  )

  // `pane` is passed explicitly by the per-pane header buttons rather than relying on the pointer
  // having already moved keyboard focus to that pane — the spawn must land where the button lives.
  const resume = useCallback(async (meta: ConversationMeta, pane?: number) => {
    if (hiddenSessionIdsRef.current.has(meta.sessionId)) return
    if (
      pane === undefined &&
      openElsewhereRef.current.has(meta.sessionId) &&
      !locateTab(paneLayoutRef.current, meta.sessionId)
    ) {
      window.api.resumeConversationElsewhere(meta.sessionId)
      return
    }
    // A Resume lifts its row to the top — the one motion that is not a drag, and always a deliberate
    // click. Written here, in the window that spawns: a Resume forwarded to another window returned
    // above, and that window's own `resume` does the write, into the store every window shares.
    const writes = sidebarModelRef.current ? resumeWrites(sidebarModelRef.current, meta.sessionId, Date.now()) : {}
    if (Object.keys(writes).length > 0) mutateRows((stored) => ({ ...stored, ...writes }))
    land(meta.sessionId, 'persistent', { pane })
    chooseSessionView(meta.sessionId, 'terminal')
    requestFocus(meta.sessionId)
    try {
      await window.api.resume(meta.sessionId, meta.cwd, meta.agent, meta.title)
    } catch (error) {
      if (!hiddenSessionIdsRef.current.has(meta.sessionId)) throw error
    }
  }, [land, requestFocus, chooseSessionView, beginVisit, mutateRows])
  const resumeRef = useRef(resume)
  resumeRef.current = resume

  /**
   * Start a conversation, from a chooser tab when `chooser` names one. The spawn takes a moment, and what
   * the user did meanwhile decides where it lands:
   *  - The chooser is still open: with tabs on it BECOMES the conversation, in place — `rekey`, since a
   *    chooser id is a placeholder that names nothing — shown only if it is still what the user is on.
   *    With tabs off it gives way and the conversation opens as the pane's one tab, as it always has.
   *  - The chooser was closed: with tabs on the conversation still gets a tab, in the background, so
   *    closing a chooser mid-start never quietly strands a session the user asked for.
   *  - No chooser (a folder's logo), or tabs off: shown only if nothing else was navigated to meanwhile.
   */
  const startNew = useCallback(async (cwd: string, agent: AgentKind, chooser?: string) => {
    const current = beginVisit()
    setLastAgent(agent) // starting an agent makes it the sticky chooser default too
    const st = await window.api.startNew(cwd, agent)
    const l = paneLayoutRef.current
    if (chooser && locateTab(l, chooser)) {
      const shown = activeTabId(l) === chooser
      if (tabsEnabledRef.current) panes.rekeyTabs(chooser, st.sessionId)
      else {
        panes.closeTabs([chooser])
        if (shown) land(st.sessionId, 'persistent')
      }
      if (shown) {
        chooseSessionView(st.sessionId, 'terminal')
        requestFocus(st.sessionId)
      }
      return
    }
    if (chooser && tabsEnabledRef.current) {
      land(st.sessionId, 'persistent', { focus: false })
      return
    }
    if (!current()) return
    land(st.sessionId, 'persistent')
    chooseSessionView(st.sessionId, 'terminal')
    requestFocus(st.sessionId)
  }, [land, requestFocus, chooseSessionView, beginVisit, panes.rekeyTabs, panes.closeTabs])

  const pickOther = useCallback(
    async (agent: AgentKind, chooser?: string) => {
      const dir = await window.api.pickDirectory()
      if (dir) await startNew(dir, agent, chooser)
    },
    [startNew]
  )

  // Read through refs, so the new-conversation handlers — and the window key handler holding them —
  // are not rebuilt on every index pass.
  const groupsRef = useRef(groups)
  groupsRef.current = groups
  const ptysBySessionRef = useRef(ptys.bySession)
  ptysBySessionRef.current = ptys.bySession

  // A new chooser tab after the active one, in the focused pane. Persistent, so a preview open does not
  // replace it — and with tabs off it sits beside the one preview tab, which Esc returns to.
  const openChooserTab = useCallback(
    (preselect: string | null) => {
      beginVisit()
      const id = chooserTabId(nextChooserRef.current++)
      // Read NOW, not inside the updater: React runs the updater during the next render, by which time
      // the selected tab is this chooser.
      const from = selectedTabIdRef.current
      setChoosers((prev) => ({ ...prev, [id]: { preselect, from, aim: 0 } }))
      // Landing on it is a landing like a tab click, which ends a multi-selection — else ⌘W, which
      // closes the focused pane's group, would close the tabs left behind rather than the chooser.
      setTabSelection(NO_SELECTION)
      panes.openTab(id, 'persistent')
    },
    [beginVisit, panes.openTab]
  )

  // Esc on a chooser: close it and go back to the tab it was opened from, not to whichever neighbor
  // slid into its slot. Revealed where it stands — a 'preview' open of a tab that exists moves nothing.
  const dismissChooser = useCallback(
    (id: string) => {
      beginVisit()
      const from = choosersRef.current[id]?.from ?? null
      panes.closeTabs([id])
      if (from !== null && from !== id && locateTab(paneLayoutRef.current, from)) panes.openTab(from, 'preview')
    },
    [beginVisit, panes.closeTabs, panes.openTab]
  )

  // "A new conversation where I am": the focused conversation's folder, per chooserPreselect.
  // On a chooser, the folder it is aimed at.
  const focusedPreselect = useCallback((): string | null => {
    const tab = selectedTabIdRef.current
    if (tab !== null && isChooserTab(tab)) return choosersRef.current[tab]?.preselect ?? null
    const id = selectedIdRef.current
    if (!id) return null
    const root = sidebarModelRef.current?.rows.get(id)?.root
    const cwd = metaByIdRef.current.get(id)?.cwd ?? ptysBySessionRef.current.get(id)?.cwd
    return root && cwd ? chooserPreselect(groupsRef.current, cwd, root) : null
  }, [])

  // ⌘N, ⌘T and the head pencil. Standing on a chooser already, they hand it the keyboard rather than
  // stack a second empty one beside it.
  const newConversation = useCallback(() => {
    const target = newConversationTarget(paneLayoutRef.current)
    if (target.kind === 'focus') requestFocus(target.id)
    else openChooserTab(focusedPreselect())
  }, [openChooserTab, focusedPreselect, requestFocus])

  // A folder's pencil: the same, aimed at that folder — re-aiming the chooser the user is on, if any.
  const newInFolder = useCallback(
    (root: string) => {
      const target = newConversationTarget(paneLayoutRef.current)
      if (target.kind === 'open') {
        openChooserTab(root)
        return
      }
      setChoosers((prev) => ({
        ...prev,
        [target.id]: { from: prev[target.id]?.from ?? null, preselect: root, aim: (prev[target.id]?.aim ?? 0) + 1 }
      }))
      requestFocus(target.id)
    },
    [openChooserTab, requestFocus]
  )

  // A folder's logo names both the folder and the agent, so it starts straight away; a failed start
  // (the folder is gone) falls back to a chooser on that folder.
  const startInFolder = useCallback(
    (root: string, agent: AgentKind) => void startNew(root, agent).catch(() => openChooserTab(root)),
    [startNew, openChooserTab]
  )

  // ⇧-click on a pencil or a folder's logo: its new conversation, in a window of its own. A null folder
  // is the head pencil's, which means where the user is — as ⇧⌘N does.
  const newInWindow = useCallback(
    (root: string | null, agent?: AgentKind) => window.api.openNewWindow(root ?? focusedPreselect(), agent),
    [focusedPreselect]
  )

  // A window opened by ⇧⌘N or a ⇧-clicked pencil starts on a chooser; one opened from a folder's logo
  // starts that conversation, falling back to the chooser if it cannot.
  const openedChooserRef = useRef(false)
  useEffect(() => {
    const init = windowInit.newConversation
    if (!init || openedChooserRef.current) return
    openedChooserRef.current = true
    if (init.agent && init.preselect !== null) startInFolder(init.preselect, init.agent)
    else openChooserTab(init.preselect)
  }, [openChooserTab, startInFolder])

  // With tabs off a chooser only ever fills the pane, so one that is no longer on screen is dropped —
  // see strayChoosers. A layout effect, so the dropped tab never paints.
  useLayoutEffect(() => {
    if (tabsEnabled) return
    const stray = strayChoosers(paneLayout)
    if (stray.length > 0) panes.closeTabs(stray)
  }, [tabsEnabled, paneLayout, panes.closeTabs])

  // Forget closed choosers. Judged against this render's committed pair — the records it held and the
  // layout it drew — and only those go: a chooser opened by an effect in this same commit has its record
  // queued but not yet its tab, and must not be mistaken for a closed one.
  useEffect(() => {
    const open = new Set<string>()
    for (const p of paneLayout.panes) for (const t of p.tabs) if (isChooserTab(t.sessionId)) open.add(t.sessionId)
    const closed = Object.keys(choosers).filter((k) => !open.has(k))
    if (closed.length === 0) return
    for (const k of closed) chooserMemoryRef.current.delete(k)
    setChoosers((prev) => {
      const next = { ...prev }
      for (const k of closed) delete next[k]
      return next
    })
  }, [paneLayout, choosers])

  // File → New Conversation / New Tab / New Window arrive as pushes: menu accelerators never reach the
  // page as keydowns. Inert behind a modal, like ⌘W.
  useEffect(
    () =>
      window.api.onMenuNewConversation(() => {
        if (!overlayOpenRef.current) newConversation()
      }),
    [newConversation]
  )
  useEffect(
    () =>
      window.api.onMenuNewWindow(() => {
        if (!overlayOpenRef.current && tabsEnabledRef.current) window.api.openNewWindow(focusedPreselect())
      }),
    [focusedPreselect]
  )
  useEffect(() => {
    window.api.setTabsMenuEnabled(tabsEnabled)
  }, [tabsEnabled])

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
      chooseSessionView(id, 'terminal')
      requestFocus(id)
    },
    [panes.focusPane, requestFocus, chooseSessionView]
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
    chooseSessionView(target, 'terminal')
    requestFocus(target)
  }, [selectedId, land, chooseSessionView, requestFocus])
  // Navigation restores each conversation's remembered surface. A live conversation with no choice
  // yet defaults to Terminal; explicit actions (Resume / New / Enter / Go live) still force Terminal.
  const openRemembered = useCallback(
    (id: string, mode: TabOpenMode = 'preview') => {
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
  // The head's needs-you tag: open the next session asking or unread, after the one you are on, in
  // rail order. Opening makes it active — which expands its folder — and opening an unread one marks
  // it read, so the count falls as you work through them.
  const openNextNeedingYou = useCallback(() => {
    const list = sidebarModelRef.current?.needsYou ?? []
    if (list.length === 0) return
    const at = selectedIdRef.current ? list.indexOf(selectedIdRef.current) : -1
    openRemembered(list[(at + 1) % list.length])
  }, [openRemembered])
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
      if (!canPlaceTabsToSide(l, [id], target)) return
      if (l.panes.length < 2) panes.splitPane()
      land(id, 'persistent', { pane: target })
      if (!isUnlinkedId(id)) markRead(id)
      requestFocus(id)
    },
    [panes.splitPane, land, isUnlinkedId, markRead, requestFocus]
  )
  // What the row menu's where-to commands are called: where openToSide would put the conversation — a
  // new pane on the right, or the existing pane on one side — and whether they move a tab this window
  // already holds or open one. See conversationMenu.
  const placementFor = useCallback((id: string): { side: SidePlace | null; hasTabHere: boolean } => {
    const l = paneLayoutRef.current
    const split = l.panes.length > 1
    const target = split ? (l.focusIndex === 0 ? 1 : 0) : 1
    const side: SidePlace | null = !canPlaceTabsToSide(l, [id], target)
      ? null
      : !split
        ? 'right'
        : target === 1
          ? 'rightPane'
          : 'leftPane'
    return { side, hasTabHere: !!locateTab(l, id) }
  }, [])
  // Send an EXISTING tab to the other pane, creating the split when there is none. Distinct from
  // openToSide, which opens a conversation over there and leaves whatever was here alone: this is a
  // move, so the source pane gives the tab up.
  const splitRightTab = useCallback(
    (sessionId: string, fromPane: number) => {
      beginVisit()
      const l = paneLayoutRef.current
      const ids = targetsFor(fromPane, sessionId)
      if (ids.length === 0 || !canPlaceTabsToSide(l, ids, 1)) return
      // "Right" is pane 1: the menu item is offered only from the left pane (see canSplitRight), so
      // there is no other direction to resolve.
      if (l.panes.length < 2) panes.splitPane()
      panes.moveTabs(ids, sessionId, { pane: 1, index: l.panes[1]?.tabs.length ?? 0 })
      panes.focusPane(1)
      if (!isUnlinkedId(sessionId)) markRead(sessionId)
      requestFocus(sessionId)
    },
    [panes.splitPane, panes.moveTabs, panes.focusPane, targetsFor, isUnlinkedId, markRead, requestFocus, beginVisit]
  )
  // Move a tab to the pane it is not in. Only reachable when a split already exists, so "the other
  // pane" is unambiguous — which is why one handler serves both Move Right and Move Left.
  const moveTabToOtherPane = useCallback(
    (sessionId: string, fromPane: number) => {
      beginVisit()
      const l = paneLayoutRef.current
      if (l.panes.length < 2) return
      const ids = targetsFor(fromPane, sessionId)
      if (ids.length === 0) return
      const to = fromPane === 0 ? 1 : 0
      panes.moveTabs(ids, sessionId, { pane: to, index: l.panes[to]?.tabs.length ?? 0 })
      panes.focusPane(to)
      if (!isUnlinkedId(sessionId)) markRead(sessionId)
      requestFocus(sessionId)
    },
    [panes.moveTabs, panes.focusPane, targetsFor, isUnlinkedId, markRead, requestFocus, beginVisit]
  )
  // "Split Right" CREATES the second pane, so it is offered only when there is not one — otherwise the
  // action is a move and says so. Also requires two tabs here: moving the only one empties this pane,
  // the layout collapses it, and the net effect would be no split at all.
  const canSplitRightFrom = useCallback(
    (index: number, sessionId: string): boolean => {
      if (paneLayout.panes.length !== 1 || index !== 0) return false
      return canPlaceTabsToSide(paneLayout, targetsFor(index, sessionId), 1)
    },
    [paneLayout, targetsFor]
  )
  // A tab was dragged onto a strip in THIS window: a reorder, or a move between panes.
  const moveTabHere = useCallback(
    (from: { pane: number; index: number }, to: { pane: number; index: number }) => {
      beginVisit()
      panes.moveTab(from, to)
      panes.focusPane(to.pane)
    },
    [panes.moveTab, panes.focusPane, beginVisit]
  )
  // A dragged multi-selection landed on a strip in this window.
  const moveTabGroupHere = useCallback(
    (sessionIds: string[], activeSessionId: string, to: { pane: number; index: number }) => {
      beginVisit()
      panes.moveTabs(sessionIds, activeSessionId, to)
      panes.focusPane(to.pane)
    },
    [panes.moveTabs, panes.focusPane, beginVisit]
  )
  // A tab group was dragged OUT of this window — another window took it, or it became a window of its
  // own. Either way this window gives up the whole payload, making the gesture a move rather than a copy.
  const tabLeftWindow = useCallback(
    (sessionIds: string[]) => panes.closeTabs(sessionIds),
    [panes.closeTabs]
  )
  // MOVE a conversation into its own window: the new window opens with it, and this window gives up
  // its tab. A move rather than a copy, matching every other way a tab travels here (drag, Move Right,
  // Move Left) — and it is what keeps one conversation from being open in two places at once.
  //
  // The tab is what moves; the live TERMINAL does not follow. One xterm per terminal app-wide, and
  // yanking it would blank the session someone may be typing in — so the new window shows the
  // transcript and offers to bring the terminal over through the serialized ownership handoff.
  //
  // From a tab this carries the selection it belongs to, which the tab menu's label counts; from a rail
  // row (`group` false) it is that conversation alone, as the row menu's label says.
  const moveToNewWindow = useCallback(
    (id: string, group = true) => {
      beginVisit()
      const at = locateTab(paneLayoutRef.current, id)
      // A group goes to ONE new window holding all of it, not one window each.
      const ids = at && group ? targetsFor(at.pane, id) : [id]
      const order = at
        ? paneLayoutRef.current.panes[at.pane].tabs.map((tab) => tab.sessionId)
        : [id]
      const payload = makeTabDragPayload(order, ids, id)
      window.api.openConversationWindow(payload)
      panes.closeTabs(payload.sessionIds)
    },
    [panes.closeTabs, targetsFor, beginVisit]
  )
  // A tab group dragged in from ANOTHER window. This is explicit placement, not an implicit "show me"
  // navigation: routing it through `land` without a pane would see the source's still-open tabs and
  // reveal that window instead of adopting them. The atomic reducer appends the ordered group to the
  // focused pane and keeps the grabbed tab active.
  useEffect(
    () =>
      window.api.onTabDropHere(({ sessionIds, activeSessionId }) => {
        const pane = paneLayoutRef.current.focusIndex
        panes.openTabs(sessionIds, activeSessionId, pane)
        setTabSelection(
          sessionIds.length > 1
            ? { pane, ids: new Set(sessionIds), anchor: activeSessionId }
            : NO_SELECTION
        )
        if (!isUnlinkedId(activeSessionId)) markRead(activeSessionId)
        requestFocus(activeSessionId)
      }),
    [panes.openTabs, isUnlinkedId, markRead, requestFocus]
  )
  // Keep main's register of which window holds which conversation current. Keyed on the SET, not on the
  // layout: activating a tab, reordering the strip and resizing the split all leave the set alone, and
  // this should not chatter for any of them.
  const openIdsKey = useMemo(
    () => [...openSessionIds(paneLayout)].sort().join('\\0'),
    [paneLayout]
  )
  useEffect(() => {
    window.api.tabsChanged(openIdsKey ? openIdsKey.split('\\0') : [])
  }, [openIdsKey])
  const persistedTabLayout = useMemo(() => snapshotPaneLayout(paneLayout), [paneLayout])
  const persistedTabLayoutKey = JSON.stringify(persistedTabLayout)
  // Seeded with the mount-time value so a window that STARTS with the preference off reads as
  // "still off" rather than as a fresh switch-off — see tabPersistPolicy for why that distinction
  // is the difference between honouring the setting and deleting the user's saved layout.
  const tabsEnabledWasRef = useRef(tabsEnabled)
  const initialWorkspaceHandledRef = useRef(false)
  useEffect(() => {
    if (initialWorkspaceHandledRef.current) return
    initialWorkspaceHandledRef.current = true
    if (!tabsEnabled) return
    if (windowInit.restoredTabs) window.api.finishTabWorkspaceActivation()
    setTabWorkspaceReady(true)
  }, [tabsEnabled, windowInit.restoredTabs])

  useEffect(() => {
    const action = tabPersistAction(tabsEnabledWasRef.current, tabsEnabled)
    tabsEnabledWasRef.current = tabsEnabled
    if (action === 'clear') {
      pendingWorkspaceKeyRef.current = null
      setTabWorkspaceReady(false)
      panes.collapseToSingle()
      window.api.clearTabWorkspace()
      return
    }
    if (action === 'activate') {
      setTabWorkspaceReady(false)
      void window.api
        .activateTabWorkspace()
        .then((saved) => {
          if (!tabsEnabledRef.current) return
          saved = visibleTabLayout(saved, hiddenSessionIdsRef.current)
          if (!saved) {
            window.api.finishTabWorkspaceActivation()
            setTabWorkspaceReady(true)
            return
          }
          pendingWorkspaceKeyRef.current = JSON.stringify(saved)
          panes.restoreLayout(saved)
        })
        .catch(() => {})
      return
    }
    if (action === 'persist' && canPersistTabWorkspace(tabsEnabled, tabWorkspaceReady)) {
      window.api.persistTabLayout(persistedTabLayout)
    }
  }, [tabsEnabled, persistedTabLayoutKey, tabWorkspaceReady, panes.collapseToSingle, panes.restoreLayout])

  useEffect(() => {
    const pending = pendingWorkspaceKeyRef.current
    const visiblePending = pending === null ? null : JSON.stringify(visibleTabLayout(JSON.parse(pending), hiddenSessionIds))
    if (!tabsEnabled || !restoredWorkspaceApplied(visiblePending, persistedTabLayoutKey)) return
    pendingWorkspaceKeyRef.current = null
    window.api.finishTabWorkspaceActivation()
    setTabWorkspaceReady(true)
  }, [tabsEnabled, persistedTabLayoutKey, hiddenSessionIds])

  useEffect(() => {
    const offElsewhere = window.api.onTabsElsewhere((ids: string[]) => {
      setOpenElsewhere(new Set(ids))
    })
    const offResume = window.api.onTabResume((sessionId: string) => {
      if (!locateTab(paneLayoutRef.current, sessionId)) return
      const meta = metaByIdRef.current.get(sessionId)
      if (meta) void resumeRef.current(meta)
      else setPendingResumeId(sessionId)
    })
    // Another window is taking it. Give the tab up — that is what makes an explicit placement a move
    // rather than a copy.
    const offRelease = window.api.onTabRelease((sessionId: string) => {
      void window.api.shouldReleaseTab(sessionId).then((shouldRelease) => {
        if (!shouldRelease) return
        const at = locateTab(paneLayoutRef.current, sessionId)
        if (at) panes.closeTab(at.pane, at.index)
      })
    })
    return () => {
      offElsewhere()
      offResume()
      offRelease()
    }
  }, [panes.openTab, panes.closeTab])

  useEffect(() => {
    if (!pendingResumeId) return
    const tabPresent = !!locateTab(paneLayout, pendingResumeId)
    const meta = metaById.get(pendingResumeId)
    const action = deferredResumeAction(tabPresent, !!meta)
    if (action === 'wait') return
    setPendingResumeId(null)
    if (action === 'resume' && meta) void resume(meta)
  }, [pendingResumeId, metaById, paneLayout, resume])

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
      const current = beginVisit()
      void window.api.claimTerminal(ptyId).then((claimed) => {
        if (claimed && current()) goLive(pane)
      })
    },
    [goLive, beginVisit]
  )
  const toggleSplit = useCallback(() => {
    beginVisit()
    if (paneLayoutRef.current.panes.length > 1) panes.unsplit()
    else panes.splitActiveTab()
    // Either way the selected tab changes pane, so a chooser remounts there — with its last focus request
    // already spent, since a chooser acts on each request once. Hand it a fresh one so typing still
    // filters. (Split Right and Move Right/Left already request focus for the tab they move.)
    const tab = selectedTabIdRef.current
    if (tab !== null && isChooserTab(tab)) requestFocus(tab)
  }, [panes.splitActiveTab, panes.unsplit, beginVisit, requestFocus])
  // The user's Stop, by conversation id — the pane header and the rail's menu both. The PtyManager
  // kills by ptyId, so the live process is resolved first; a no-op if the conversation isn't live.
  // Remembered until the process exits, when an empty conversation's tab closes — see stopClose.
  const stoppedRef = useRef(new Set<string>())
  const stopSession = useCallback(
    (id: string) => {
      const pty = ptys.bySession.get(id)
      if (!pty) return
      stoppedRef.current.add(id)
      window.api.kill(pty.ptyId)
    },
    [ptys.bySession]
  )
  useEffect(() => {
    for (const id of endedStops(stoppedRef.current, ptys.bySession)) {
      stoppedRef.current.delete(id)
      if ((metaByIdRef.current.get(id)?.messageCount ?? 0) > 0) continue
      // A revision of its own, so the read is fresh from disk rather than a parse already in flight.
      void window.api
        .getTranscript(id, `stopped:${Date.now()}`)
        .then((t) => {
          if (ptysBySessionRef.current.has(id)) return
          if (emptyAfterStop(metaByIdRef.current.get(id)?.messageCount ?? 0, t)) panes.closeTabs([id])
        })
        .catch(() => {})
    }
  }, [ptys.bySession, panes.closeTabs])
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

  // Reveal a group's next step of rows past its cap, or return it to the cap. The step is the cap.
  const showMore = useCallback(
    (key: string) => {
      const step = sidebarMode === 'all' ? DEFAULT_SIDEBAR_LIMITS.allCap : DEFAULT_SIDEBAR_LIMITS.folderCap
      setRevealed((r) => ({ ...r, [key]: (r[key] ?? 0) + step }))
    },
    [sidebarMode]
  )
  const showLess = useCallback((key: string) => {
    setRevealed((r) => {
      if (!Object.hasOwn(r, key)) return r
      const next = { ...r }
      delete next[key]
      return next
    })
  }, [])

  // A header click writes the folder's preference — the opposite of what it shows. Collapsing also
  // forgets that navigation opened it and closes it even over an active conversation in it; expanding
  // lifts that. Both hold until navigation next enters the folder.
  const toggleFolder = useCallback(
    (root: string) => {
      const group = sidebarModelRef.current?.groups.find((g) => g.key === root)
      if (!group) return
      const collapse = !group.collapsed
      setFolderCollapsed(root, collapse)
      if (collapse) {
        setNavExpanded((prev) => withoutFolders(prev, [root]))
        setActiveCollapsed((prev) => withFolders(prev, [root]))
      } else {
        setActiveCollapsed((prev) => withoutFolders(prev, [root]))
      }
    },
    [setFolderCollapsed]
  )

  // Collapse all / Expand all: the preference for every folder, rendered or not, and the navigation
  // expansions with it — otherwise every folder visited this session would stay open. Collapse all
  // closes the active conversation's folder too, like a header click would.
  const setAllCollapsed = useCallback(
    (collapsed: boolean) => {
      const model = sidebarModelRef.current
      if (!model) return
      const roots = [...model.folders.keys()]
      setFoldersCollapsed(roots, collapsed)
      setNavExpanded((prev) => (prev.size === 0 ? prev : new Set()))
      setActiveCollapsed((prev) => (collapsed ? withFolders(prev, roots) : prev.size === 0 ? prev : new Set()))
    },
    [setFoldersCollapsed]
  )

  // A drop between two neighbors of one block. Pins move within the one app-wide pin list; every
  // other row writes a rank into the global space, so the drop holds in both modes.
  const dropRow = useCallback(
    (block: SidebarBlock, draggedId: string, higherId: string | null, lowerId: string | null) => {
      if (block.kind === 'pinned') movePin(draggedId, higherId, lowerId)
      else {
        const model = sidebarModelRef.current
        if (!model) return
        const writes = dropWrites(rankSpace(model), draggedId, higherId, lowerId, Date.now())
        if (Object.keys(writes).length > 0) mutateRows((stored) => ({ ...stored, ...writes }))
      }
      setReorderTick((t) => t + 1)
    },
    [movePin, mutateRows]
  )

  // A folder dropped between two neighboring folders: one key in the folder rank space, the same
  // arithmetic as a row.
  const dropFolder = useCallback(
    (root: string, higherRoot: string | null, lowerRoot: string | null) => {
      const model = sidebarModelRef.current
      if (!model) return
      const writes = dropWrites(folderRankSpace(model), root, higherRoot, lowerRoot, Date.now())
      if (Object.keys(writes).length > 0) mutateFolders((stored) => ({ ...stored, ...writes }))
      setReorderTick((t) => t + 1)
    },
    [mutateFolders]
  )

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

  // A tab's × and middle-click close that tab alone, even inside a multi-selection; the menu's Close,
  // which counts the tabs it acts on, is what closes a selection.
  const closeOneTab = useCallback(
    (pane: number, index: number) => {
      beginVisit()
      panes.closeTab(pane, index)
    },
    [panes.closeTab, beginVisit]
  )
  // ⌥-× on a running tab: end the session, then close the tab — its own, as the plain × does.
  const stopAndCloseTab = useCallback(
    (pane: number, index: number) => {
      const id = paneLayoutRef.current.panes[pane]?.tabs[index]?.sessionId
      if (!id) return
      stopSession(id)
      closeOneTab(pane, index)
    },
    [stopSession, closeOneTab]
  )
  // The conversation commands a tab's menu shares with its rail row, run by the same handlers.
  const runTabCommand = useCallback(
    (command: TabConversationCommand, id: string) => {
      if (command === 'resume') resumeSession(id)
      else if (command === 'pin' || command === 'unpin') togglePinGated(id)
      else if (command === 'markRead' || command === 'markUnread') toggleUnread(id)
      else if (command === 'rename') showInfo(id, true)
      else stopSession(id)
    },
    [resumeSession, togglePinGated, toggleUnread, showInfo, stopSession]
  )

  // Clear a manual "unread" mark once the user genuinely engages the open conversation — a click
  // or keystroke in the pane body (see MainPane's listener). Gated on an existing flag so plain
  // typing in the terminal doesn't churn state past the first keystroke.
  const onEngage = useCallback((id: string) => {
    if (unread[id] != null) markRead(id)
  }, [unread, markRead])

  // Find-in-conversation searches the rendered transcript, so the first keystroke while a live
  // Terminal is showing switches to Formatted (remembering the prior view to restore on close).
  const onFindActivate = useCallback(() => {
    if (selectedId && effectiveView === 'terminal') {
      findPriorTerminalIdsRef.current.add(selectedId)
      setSessionView(selectedId, 'transcript')
    }
  }, [selectedId, effectiveView, setSessionView])

  // The pane-header magnifier toggles find (closeFind restores the prior view on the way out).
  const toggleFind = useCallback(() => {
    if (findOpen) closeFind()
    else setFindOpen(true)
  }, [findOpen, closeFind])

  // --- keyboard ---
  // ⌘N / ⌘T / ⇧⌘N and ⌘W are File-menu accelerators and never arrive here as keydowns — see the
  // onMenu* subscriptions.
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
      // The conversation-info modal owns the keyboard like Preferences: Esc closes it, the rest is inert.
      // (While its title field is editing, the input's own Esc handler stopPropagation's to cancel the
      // edit without bubbling here — so a first Esc backs out of edit, a second closes the modal.)
      if (infoModal) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setInfoModal(null)
        }
        return
      }
      const viewAction = viewToggleAction(
        e,
        effectiveView,
        focusedView.terminalAt ?? (selectedMeta ? 'resumable' : null)
      )
      if (viewAction !== null && selectedId) {
        e.preventDefault()
        if (viewAction === 'resume') {
          if (selectedMeta) void resume(selectedMeta, paneLayout.focusIndex)
        } else if (viewAction === 'claim') {
          if (selectedPty) claimTerminal(selectedPty.ptyId, paneLayout.focusIndex)
        } else {
          chooseSessionView(selectedId, viewAction)
          requestFocus(selectedId)
        }
      } else if (mod && e.key.toLowerCase() === 'f') {
        // Matched on the lowercased key, so ⇧⌘F lands here too.
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
        // ⌘\ — toggle the vertical split. Opening moves the active tab into a new right pane; closing
        // merges its tabs back into the survivor, keeping whatever you were looking at selected. With
        // fewer than two tabs, opening is a no-op so neither pane can be left empty. ⇧⌘\ is free.
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
        goHistory(-1)
      } else if (mod && e.key === ']') {
        e.preventDefault()
        goHistory(1)
      } else if (e.key === 'Escape') {
        if (findOpen) closeFind()
        else if (query) setQuery('')
        else setSearchOpen(false)
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
    infoModal,
    findOpen,
    closeFind,
    selectedId,
    selectedMeta,
    selectedPty,
    effectiveView,
    focusedView.terminalAt,
    claimTerminal,
    chooseSessionView,
    requestFocus,
    orderedIds,
    resume,
    enterLive,
    switchTo,
    goHistory,
    togglePane,
    toggleUnread,
    tabsEnabled,
    paneLayout,
    goToTab,
    toggleSplit
  ])

  // Find belongs to whichever pane has the keyboard. Moving to the other pane closes it rather than
  // teleporting the bar: the query lives in that pane's own component, so it could not follow anyway.
  useEffect(() => {
    closeFind()
  }, [paneLayout.focusIndex, closeFind])

  // Resolve the info-modal target's meta + live process. A live-but-unindexed session still resolves
  // via the synthesized meta, mirroring the rail.
  const visibleInfoModal = infoModal && !hiddenSessionIds.has(infoModal.sessionId) ? infoModal : null
  const infoPty = visibleInfoModal ? ptys.bySession.get(visibleInfoModal.sessionId) ?? null : null
  const infoMeta = visibleInfoModal
    ? metaById.get(visibleInfoModal.sessionId) ?? (infoPty ? synthMeta(infoPty) : null)
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
        onHome={() => { beginVisit(); panes.deselect() }}
        onOpenSettings={() => setSettingsPage('appearance')}
        resolvedTheme={themeResolved}
        onToggleTheme={toggleTheme}
        updatesNeedAttention={updates.needsAttention}
        split={paneLayout.panes.length > 1}
        splitDisabled={paneLayout.panes.length < 2 && !canSplitActiveTab(paneLayout)}
        onToggleSplit={tabsEnabled ? toggleSplit : undefined}
      />
      <div
        className="sb-body"
        ref={bodyElRef}
        style={{ '--pane-w': `${paneWidth}px` } as CSSProperties}
      >
        {!paneCollapsed && (
          <Sidebar
            model={sidebarModel}
            mode={sidebarMode}
            onModeChange={setSidebarMode}
            density={railDensity}
            onNeedsYou={openNextNeedingYou}
            onSetAllCollapsed={setAllCollapsed}
            loading={loading}
            selectedSessionId={selectedId}
            onJump={clickLive}
            onSelect={clickConversation}
            onStick={tabsEnabled ? stickConversation : undefined}
            openElsewhere={openElsewhere}
            onOpenToSide={tabsEnabled ? openToSide : undefined}
            placementFor={tabsEnabled ? placementFor : undefined}
            onOpenInNewWindow={tabsEnabled ? (id: string) => moveToNewWindow(id, false) : undefined}
            onTogglePin={togglePinGated}
            query={query}
            onQueryChange={setQuery}
            searchRef={searchRef}
            searchOpen={searchOpen}
            onSearchToggle={toggleSearch}
            searching={searching}
            onToggleFolder={toggleFolder}
            revealed={revealed}
            onShowMore={showMore}
            onShowLess={showLess}
            onNewConversation={newConversation}
            agents={availableAgents}
            onNewInFolder={newInFolder}
            onStartInFolder={startInFolder}
            onNewInWindow={tabsEnabled ? newInWindow : undefined}
            onToggleUnread={toggleUnread}
            onMarkUnread={markUnreadGated}
            onResumeSession={resumeSession}
            onStopSession={stopSession}
            onShowInfo={showInfo}
            onDropRow={dropRow}
            onDropFolder={dropFolder}
            reorderTick={reorderTick}
          />
        )}
        {!paneCollapsed && (
          <ResizeHandle
            ariaLabel="Resize pane"
            onResizeStart={() => {
              dragStartRef.current = paneWidth
            }}
            onResize={(dx) => {
              const width = Math.max(PANE_LIMITS.min, Math.min(PANE_LIMITS.max, dragStartRef.current + dx))
              bodyElRef.current?.style.setProperty('--pane-w', `${Math.round(width)}px`)
            }}
            onResizeEnd={(dx) => setPaneWidth(dragStartRef.current + dx)}
            onReset={resetPane}
          />
        )}
        {/* One or two conversation panes side by side. Keyed by the pane's own id, not its index, so
            splitting and unsplitting never remounts a surviving pane — which would drop its terminal
            deck, its find state, and every remembered transcript position. */}
        <div
          className={`sb-panes${paneLayout.panes.length > 1 ? ' split' : ''}`}
          ref={panesElRef}
          style={{
            '--split-left-grow': paneLayout.splitFraction,
            '--split-right-grow': 1 - paneLayout.splitFraction
          } as CSSProperties}
        >
          {paneLayout.panes.map((pane, i) => {
            const v = i === 1 ? view1 : view0
            const isFocused = i === paneLayout.focusIndex
            const split = paneLayout.panes.length > 1
            const grow = i === 0 ? 'var(--split-left-grow)' : 'var(--split-right-grow)'
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
                      if (width <= 0) return
                      const next = Math.max(
                        SPLIT_LIMITS.min,
                        Math.min(SPLIT_LIMITS.max, fraction + dx / width)
                      )
                      panesElRef.current?.style.setProperty('--split-left-grow', String(next))
                      panesElRef.current?.style.setProperty('--split-right-grow', String(1 - next))
                    }}
                    onResizeEnd={(dx) => {
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
                  onPaneFocus={split ? () => focusPane(i) : undefined}
                  terminalAt={v.terminalAt}
                  onClaimTerminal={() => {
                    if (v.pty) claimTerminal(v.pty.ptyId, i)
                  }}
                  showTabs={tabsEnabled}
                  tabLayout={tabLayout}
                  tabs={tabsByPane[i] ?? []}
                  activeTabIndex={pane.activeIndex}
                  onActivateTab={goToTab}
                  onCloseTab={closeTabsFrom}
                  onCloseOneTab={closeOneTab}
                  onStopAndCloseTab={stopAndCloseTab}
                  onTabCommand={runTabCommand}
                  onCloseOtherTabs={panes.closeOtherTabs}
                  onPromoteTab={panes.promoteTab}
                  canSplitRight={(id) => canSplitRightFrom(i, id)}
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
                  focusReq={focusReq}
                  transcript={i === 1 ? transcript1 : transcript0}
                  transcriptLoading={i === 1 ? loading1 : loading0}
                  transcriptScrollStateRef={transcriptScrollStateRef}
                  pinned={v.id ? pinned.has(v.id) : false}
                  unlinked={v.id ? isUnlinkedId(v.id) : false}
                  onTogglePin={() => {
                    if (v.id) togglePinGated(v.id)
                  }}
                  onResume={() => {
                    if (v.meta) void resume(v.meta, i)
                  }}
                  onShowHistory={() => {
                    if (v.id) chooseSessionView(v.id, 'transcript')
                  }}
                  onGoLive={() => goLive(i)}
                  onKill={() => {
                    if (v.pty) stopSession(v.pty.sessionId)
                  }}
                  onShowInfo={() => {
                    if (v.id) showInfo(v.id, false)
                  }}
                  onEngage={onEngage}
                  terminalHostRef={i === 1 ? setTerminalHost1 : setTerminalHost0}
                  paneRef={i === 1 ? pane1Ref : pane0Ref}
                  // Find belongs to the pane holding the keyboard; the other pane never shows the bar.
                  findOpen={findOpen && isFocused}
                  findFocusReq={findFocusReq}
                  onFindClose={closeFind}
                  onFindActivate={onFindActivate}
                  onFindToggle={toggleFind}
                  markdownCopy={markdownCopy}
                  chooser={
                    v.chooser && (
                      <ChooserView
                        key={v.chooser}
                        id={v.chooser}
                        folders={i === 1 ? folders1 : folders0}
                        aim={choosers[v.chooser]?.aim ?? 0}
                        agents={availableAgents}
                        initialAgent={chooserAgent}
                        onAgentChange={setLastAgent}
                        onStart={(dir, agent) => startNew(dir, agent, v.chooser ?? undefined)}
                        onPickOther={(agent) => pickOther(agent, v.chooser ?? undefined)}
                        onDismiss={() => {
                          if (v.chooser) dismissChooser(v.chooser)
                        }}
                        focusKey={
                          focusReq && focusReq.sessionId === v.chooser && isFocused ? focusReq.n : null
                        }
                        memory={chooserMemoryRef}
                      />
                    )
                  }
                />
              </Fragment>
            )
          })}
        </div>
        <TerminalDeck
          activePtys={ownedPtys}
          homes={ptyHome}
          paneHosts={terminalHosts}
          visiblePtyIds={visiblePtyIds}
          focusReq={focusReq}
          theme={themeResolved}
          onMarkUnread={markUnreadGated}
        />
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
        railDensity={railDensity}
        onSetRailDensity={setRailDensity}
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
        tabLayout={tabLayout}
        onSetTabLayout={setTabLayout}
        dotColor={dotColor}
        onSetDotColor={setDotColor}
        onPreviewDotColor={previewDotColor}
      />
      <ConversationInfoModal
        open={visibleInfoModal !== null}
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
