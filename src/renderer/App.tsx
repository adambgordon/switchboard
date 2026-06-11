import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ConversationMeta, LiveState, PtyState } from '@shared/types'
import { useSessions } from './lib/useSessions'
import { usePtys } from './lib/usePtys'
import { usePins } from './lib/usePins'
import { useLiveOrder } from './lib/useLiveOrder'
import { useLayout } from './lib/useLayout'
import { useNewConvoDefault } from './lib/useNewConvoDefault'
import { useMaxLiveSessions } from './lib/useMaxLiveSessions'
import { useSeen } from './lib/useSeen'
import { useWindowFocus } from './lib/useWindowFocus'
import { useTranscript } from './lib/useTranscript'
import { useNavHistory } from './lib/useNavHistory'
import { useTheme } from './lib/useTheme'
import { searchConversations } from './lib/fuzzy'
import { basename } from './lib/format'
import { initPtyStream } from './lib/ptyStream'
import { resolveLiveState, isManualUnread } from './lib/liveness'
import TitleBar from './components/TitleBar'
import MainPane from './components/MainPane'
import TallyRail, { visibleEntries, type RailEntry, type RailSection } from './components/TallyRail'
import ResizeHandle from './components/ResizeHandle'
import SettingsModal from './components/SettingsModal'
import CapWarningModal from './components/CapWarningModal'
import TooltipLayer from './components/TooltipLayer'

type View = 'transcript' | 'terminal'

/** Recent section: rows shown in 'recent' mode before toggling to 'all'. */
const RECENT_CAP = 30

/** Display-only meta for a live session the index hasn't caught yet (no preview until its JSONL is written). */
function synthMeta(p: PtyState): ConversationMeta {
  return {
    sessionId: p.sessionId,
    cwd: p.cwd,
    title: p.title,
    preview: '',
    gitBranch: null,
    mtime: p.lastActivity,
    messageCount: 0,
    version: null,
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
  const { order: liveOrder, reorder: reorderLive } = useLiveOrder(liveUnpinnedIds)
  const commitLiveReorder = useCallback(
    (from: number, to: number) => {
      reorderLive(from, to)
      setReorderTick((t) => t + 1)
    },
    [reorderLive]
  )
  const { seen, unread, markUnread, markRead } = useSeen()
  const {
    dir: defaultDir,
    enabled: defaultDirEnabled,
    setDir: setDefaultDir,
    setEnabled: setDefaultDirEnabled
  } = useNewConvoDefault()
  const {
    value: maxLive,
    min: maxLiveMin,
    max: maxLiveMax,
    defaultValue: maxLiveDefault,
    inc: incMaxLive,
    dec: decMaxLive,
    reset: resetMaxLive
  } = useMaxLiveSessions()
  const { mode: themeMode, resolved: themeResolved, setMode: setThemeMode, toggle: toggleTheme } = useTheme()
  const focused = useWindowFocus()
  const {
    paneWidth,
    paneCollapsed,
    sections: collapsedSections,
    setPaneWidth,
    togglePane,
    resetPane,
    toggleSection
  } = useLayout()
  const dragStartRef = useRef(0)

  const { selectedId, open, preview, home, back, forward } = useNavHistory()
  // Session-targeted focus request, bumped only on a *deliberate* focus (click / Enter / Right
  // arrow on a live row / resume / new / go-live) — never on ↑/↓ preview or back/forward.
  // Previewing a live row therefore shows its terminal without stealing the keyboard, so arrow
  // nav doesn't get trapped on it.
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
  const [settingsPage, setSettingsPage] = useState<'app' | 'shortcuts' | null>(null)
  // Section keys revealed past their cap via "Show more" (ephemeral — resets on reload).
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  // The rail (left pane) root — ⌘G focuses it so the keyboard returns to list-nav from the main
  // pane / terminal. It's tabIndex={-1} (focusable only programmatically); feedback is the selected
  // row, not a focus ring.
  const railRef = useRef<HTMLElement>(null)
  // Find-in-conversation (main pane). App owns the open/close toggle — ⌘F opens it when focus is
  // in the main pane, Esc closes it; the query + match state live in MainPane. `paneRef` lets the
  // ⌘F handler tell whether focus is physically inside the main pane vs the rail/list.
  const paneRef = useRef<HTMLElement>(null)
  // Snapshot — taken on mousedown, BEFORE the browser moves focus — of whether focus was inside the
  // main pane. Row clicks read it to toggle focus on the already-open conversation: if focus was in
  // the pane the click releases to the list (the mousedown already did so); if it was on the list the
  // click pulls focus back into the pane. So repeated clicks on the same row flip focus back and forth.
  const focusInPaneAtDownRef = useRef(false)
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

  // Capture, on every mousedown's *capture* phase (before the click moves focus), whether focus was
  // inside the main pane — read by the row-click handlers to toggle pane/list focus on a repeat click
  // of the already-open conversation. Capture-phase + window so it beats xterm's own mousedown handling.
  useEffect(() => {
    const onDown = (): void => {
      focusInPaneAtDownRef.current = !!paneRef.current && paneRef.current.contains(document.activeElement)
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [])

  // Keep the main-process LRU cap in lockstep with the persisted preference — on mount and on each
  // change. Fire-and-forget, and runs after commit, so it never touches the render/paint path.
  useEffect(() => {
    window.api.setMaxLiveSessions(maxLive)
  }, [maxLive])

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
  const railSections = useMemo<RailSection[]>(() => {
    // Resolve a live row's three-state liveness; null for rows with no live process.
    const stateFor = (pty: PtyState | null, meta: ConversationMeta | undefined, id: string): LiveState | null =>
      pty
        ? resolveLiveState(meta, seen[id] ?? 0, focused && selectedId === id, isManualUnread(unread[id], meta), pty.startedAt)
        : null

    const pinnedEntries: RailEntry[] = pinnedOrder
      .map((id) => {
        const pty = ptys.bySession.get(id) ?? null
        // Prefer indexed meta; fall back to the live process so a pinned-but-
        // unindexed session still renders a full row. Drop truly stale pins.
        const meta = metaById.get(id) ?? (pty ? synthMeta(pty) : null)
        return meta
          ? { sessionId: id, pty, meta, pinned: true, liveState: stateFor(pty, meta, id) }
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
        return { sessionId: id, pty, meta, pinned: false, liveState: stateFor(pty, meta, id) }
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
  }, [pinned, pinnedOrder, liveOrder, metaById, ptys.bySession, allConversations, matchIds, seen, unread, selectedId, focused])

  // Live-session tally over ALL live sessions — never the search-filtered rail set, so the rail's
  // count + status line reflect everything running even while a query narrows the visible rows.
  const liveTally = useMemo(() => {
    let working = 0
    let asking = 0
    let waiting = 0
    let idle = 0
    for (const p of ptys.active) {
      const meta = metaById.get(p.sessionId) ?? synthMeta(p)
      const st = resolveLiveState(
        meta,
        seen[p.sessionId] ?? 0,
        focused && selectedId === p.sessionId,
        isManualUnread(unread[p.sessionId], meta),
        p.startedAt
      )
      if (st === 'working') working++
      else if (st === 'asking') asking++
      else if (st === 'awaiting') waiting++
      else idle++
    }
    return { count: ptys.active.length, working, asking, waiting, idle }
  }, [ptys.active, metaById, seen, unread, focused, selectedId])

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

  const selectedMeta = selectedId ? metaById.get(selectedId) ?? null : null
  const selectedPty = selectedId ? ptys.bySession.get(selectedId) ?? null : null

  // Looking at a conversation (selected + focused) marks it read: it advances the seen marker
  // AND clears any manual-unread override — so selecting/clicking a conversation (or a turn
  // finishing under your eyes) drops the dot to quiet. Re-fires when a new turn lands.
  useEffect(() => {
    if (selectedId && focused) markRead(selectedId)
  }, [selectedId, focused, selectedMeta?.turnEndedAt, markRead])

  // The view this conversation last had (default: Formatted). Terminal only
  // applies while the session is live; otherwise fall back to its transcript.
  const requestedView: View = selectedId ? viewBySession[selectedId] ?? 'transcript' : 'transcript'
  const effectiveView: View = requestedView === 'terminal' && selectedPty ? 'terminal' : 'transcript'
  const { transcript, loading: tLoading } = useTranscript(selectedId, effectiveView === 'transcript')

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
  const recentDirs = useMemo(() => groups.map((g) => g.cwd), [groups])

  // --- actions: a live process is created ONLY by resume() or startNew() ---
  // Remember a conversation's chosen view so it sticks across navigation.
  const setSessionView = useCallback((id: string, v: View) => {
    setViewBySession((prev) => (prev[id] === v ? prev : { ...prev, [id]: v }))
  }, [])

  // Arrow keys preview (transient selection, no history); deliberate opens (click / Enter /
  // resume / new / jump) go through useNavHistory's `open`, which records a back/forward stop.
  const resume = useCallback(async (meta: ConversationMeta) => {
    open(meta.sessionId)
    setSessionView(meta.sessionId, 'terminal')
    requestFocus(meta.sessionId)
    await window.api.resume(meta.sessionId, meta.cwd, meta.title)
  }, [open, requestFocus, setSessionView])

  const startNew = useCallback(async (cwd: string) => {
    setMenuOpen(false)
    const st = await window.api.startNew(cwd)
    open(st.sessionId)
    setSessionView(st.sessionId, 'terminal')
    requestFocus(st.sessionId)
  }, [open, requestFocus, setSessionView])

  const pickOther = useCallback(async () => {
    const dir = await window.api.pickDirectory()
    if (dir) await startNew(dir)
  }, [startNew])

  // The "+" / ⌘N primary action. With a default folder enabled, spawn straight into it (skipping the
  // chooser); if that folder has since been deleted, startNew rejects (main guards the cwd) and we
  // fall back to opening the chooser. Otherwise toggle the chooser menu, exactly as before.
  const newConversation = useCallback(() => {
    if (defaultDirEnabled && defaultDir) void startNew(defaultDir).catch(() => setMenuOpen(true))
    else setMenuOpen((o) => !o)
  }, [defaultDirEnabled, defaultDir, startNew])

  // Right-clicking the "+" always opens the chooser, even when a default is set — the escape hatch to
  // start somewhere else once without toggling the setting off in Preferences.
  const openNewMenu = useCallback(() => setMenuOpen(true), [])

  // Preferences (App page) handlers for the default folder. Choosing one auto-enables it (you pick a
  // folder in order to use it); the toggle then turns it off/on without losing the path; clearing it
  // disables (nothing left to point at).
  const chooseDefaultDir = useCallback(async () => {
    const dir = await window.api.pickDirectory()
    if (dir) {
      setDefaultDir(dir)
      setDefaultDirEnabled(true)
    }
  }, [setDefaultDir, setDefaultDirEnabled])
  const clearDefaultDir = useCallback(() => {
    setDefaultDir('')
    setDefaultDirEnabled(false)
  }, [setDefaultDir, setDefaultDirEnabled])
  const toggleDefaultDirEnabled = useCallback(
    () => setDefaultDirEnabled(!defaultDirEnabled),
    [defaultDirEnabled, setDefaultDirEnabled]
  )

  const goLive = useCallback(() => {
    if (selectedId) {
      setSessionView(selectedId, 'terminal')
      requestFocus(selectedId)
    }
  }, [selectedId, requestFocus, setSessionView])
  // Enter/focus a live conversation's terminal: record a history stop, switch to the Terminal
  // view, and hand it the keyboard so you can type immediately. The optional `id` lets a click
  // target a row that isn't selected yet; with no arg it acts on `selectedId`. Shared by Enter,
  // the Right arrow, AND a live-row click (every call site guards on a live pty, so a not-live
  // selection never lands here). A click thus behaves exactly like ⏎ / → — it focuses the
  // terminal — while arrow ↑/↓ still only *preview* (no focus), so list-nav is unaffected.
  const enterLive = useCallback((id?: string) => {
    const target = id ?? selectedId
    if (!target) return
    open(target)
    setSessionView(target, 'terminal')
    requestFocus(target)
  }, [selectedId, open, setSessionView, requestFocus])
  // A live-row CLICK (not ⏎/→): a *different* live row jumps in + focuses its terminal. The row
  // you're already on TOGGLES: enter the terminal only if focus was on the list at mousedown; if it
  // was already in the pane, do nothing and let the click's own blur release focus to the list. So
  // repeated clicks on the same row flip focus list↔terminal. (⏎ / → still always enter.)
  const clickLive = useCallback(
    (id: string) => {
      if (id !== selectedId || !focusInPaneAtDownRef.current) enterLive(id)
    },
    [selectedId, enterLive]
  )
  // A not-live row CLICK: hand the keyboard to the Formatted view, parallel to clickLive focusing a
  // live row's terminal. A *different* row → open it + focus the pane. The row you're already on
  // TOGGLES: pull focus back into the pane only if it was on the list at mousedown; if it was already
  // in the pane, do nothing and let the click's blur release to the list. Repeated clicks flip focus.
  const clickConversation = useCallback(
    (id: string) => {
      // Focus the pane synchronously so the row lands in its quiet (pane-focused) selected state from
      // the first frame, independent of when the transcript mounts/loads (TranscriptView refines focus
      // onto its scroll container once mounted). Without this, the first not-live click after a live
      // one — where TranscriptView was unmounted — leaves a frame on the loading / no-history state
      // with focus still on the rail, so the row briefly paints loud.
      const focusFormatted = (): void => {
        requestFocus(id)
        paneRef.current?.focus({ preventScroll: true })
      }
      if (id !== selectedId) {
        open(id)
        focusFormatted()
      } else if (!focusInPaneAtDownRef.current) {
        focusFormatted()
      }
    },
    [selectedId, open, requestFocus]
  )
  const showHistory = useCallback(() => {
    if (selectedId) setSessionView(selectedId, 'transcript')
  }, [selectedId, setSessionView])
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

  // Resolve the current dot state for any session id (used by the read/unread toggle).
  const liveStateOf = useCallback(
    (id: string): LiveState | null => {
      const pty = ptys.bySession.get(id)
      if (!pty) return null
      const meta = metaById.get(id) ?? synthMeta(pty)
      return resolveLiveState(meta, seen[id] ?? 0, focused && selectedId === id, isManualUnread(unread[id], meta), pty.startedAt)
    },
    [ptys.bySession, metaById, seen, unread, focused, selectedId]
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
      const inMain = !!paneRef.current && paneRef.current.contains(document.activeElement)
      // While the Preferences modal is open it owns the keyboard: Esc closes it; ⌘, and ⌘?
      // toggle between (or out of) the App / Shortcuts pages; everything else is
      // inert (no list-nav behind the scrim).
      if (settingsPage !== null) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setSettingsPage(null)
        } else if (mod && e.key === ',') {
          e.preventDefault()
          setSettingsPage((p) => (p === 'app' ? null : 'app'))
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
      if (mod && e.key.toLowerCase() === 'n') {
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
      } else if (mod && e.code === 'KeyG') {
        // ⌘G — focus the conversation list (rail) so ↑/↓/⏎ drive list-nav again; pulls the keyboard
        // out of the main pane / terminal. Seed the first visible row if nothing's selected yet.
        e.preventDefault()
        railRef.current?.focus()
        if (!selectedId && orderedIds.length > 0) preview(orderedIds[0])
      } else if (mod && e.shiftKey && e.code === 'KeyU') {
        // ⇧⌘U — toggle read/unread on the selected conversation (macOS Mail's shortcut).
        e.preventDefault()
        if (selectedId) toggleUnread(selectedId)
      } else if (mod && e.key === ',') {
        // ⌘, — macOS-standard Preferences shortcut; opens the Preferences modal to its App page.
        e.preventDefault()
        setSettingsPage('app')
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
      } else if (e.key === 'Enter' && !inInput && !inMain && selectedId) {
        // Enter "opens" the selection: a live conversation focuses into its terminal (the only
        // way arrow-nav hands the keyboard to claude), a not-live one resumes. Both record a
        // history stop. Once the terminal has focus, xterm consumes Enter before it reaches
        // here, so this only ever fires from the list.
        e.preventDefault()
        if (selectedPty) enterLive()
        else if (selectedMeta) void resume(selectedMeta)
      } else if (e.key === 'ArrowRight' && !inInput && !inMain && selectedId && selectedPty) {
        // Right arrow enters a *live* conversation — idempotent to Enter on a live row. The
        // condition requires a live pty, so it's a no-op on a not-live row (those still need
        // Enter / Resume). Like Enter, once focus is inside the terminal xterm consumes arrows
        // before they reach here, so this only fires from the list.
        e.preventDefault()
        enterLive()
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !inInput && !inMain && orderedIds.length > 0) {
        // Arrow keys preview only — they never focus a live terminal or record history.
        e.preventDefault()
        const idx = selectedId ? orderedIds.indexOf(selectedId) : -1
        const next =
          e.key === 'ArrowDown'
            ? Math.min(orderedIds.length - 1, idx + 1)
            : Math.max(0, idx - 1)
        const nid = orderedIds[next < 0 ? 0 : next]
        if (nid) preview(nid)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    query,
    settingsPage,
    capWarning,
    findOpen,
    closeFind,
    selectedId,
    selectedMeta,
    selectedPty,
    orderedIds,
    resume,
    enterLive,
    preview,
    back,
    forward,
    togglePane,
    toggleUnread,
    newConversation
  ])

  const title = selectedMeta?.title ?? selectedPty?.title ?? 'Conversation'
  const cwd = selectedMeta?.cwd ?? selectedPty?.cwd ?? ''

  return (
    <div className="sb-app">
      <TitleBar
        paneCollapsed={paneCollapsed}
        onTogglePane={togglePane}
        onHome={home}
        onOpenSettings={() => setSettingsPage('app')}
        resolvedTheme={themeResolved}
        onToggleTheme={toggleTheme}
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
            onTogglePin={togglePin}
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
            onChooseDir={startNew}
            onPickOther={pickOther}
            defaultDirActive={defaultDirEnabled && !!defaultDir}
            defaultDirLabel={defaultDir ? basename(defaultDir) : ''}
            onShowHelp={() => setSettingsPage('shortcuts')}
            onToggleUnread={toggleUnread}
            onMarkUnread={markUnread}
            onResumeSession={resumeSession}
            onStopSession={stopSession}
            onReorderPins={commitReorder}
            pinnedOrder={pinnedOrder}
            onReorderLive={commitLiveReorder}
            liveOrder={liveOrder}
            reorderTick={reorderTick}
            railRef={railRef}
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
        <MainPane
          selectedId={selectedId}
          title={title}
          cwd={cwd}
          meta={selectedMeta}
          pty={selectedPty}
          view={effectiveView}
          theme={themeResolved}
          focusReq={focusReq}
          transcript={transcript}
          transcriptLoading={tLoading}
          activePtys={ptys.active}
          pinned={selectedId ? pinned.has(selectedId) : false}
          onTogglePin={() => {
            if (selectedId) togglePin(selectedId)
          }}
          onResume={() => {
            if (selectedMeta) void resume(selectedMeta)
          }}
          onShowHistory={showHistory}
          onGoLive={goLive}
          onKill={() => {
            if (selectedPty) killSession(selectedPty.ptyId)
          }}
          onEngage={onEngage}
          onMarkUnread={markUnread}
          paneRef={paneRef}
          findOpen={findOpen}
          findFocusReq={findFocusReq}
          onFindClose={closeFind}
          onFindActivate={onFindActivate}
          onFindToggle={toggleFind}
        />
      </div>
      <SettingsModal
        page={settingsPage}
        onChangePage={setSettingsPage}
        onClose={() => setSettingsPage(null)}
        themeMode={themeMode}
        onSetThemeMode={setThemeMode}
        defaultDir={defaultDir}
        defaultDirEnabled={defaultDirEnabled}
        onChooseDefaultDir={chooseDefaultDir}
        onClearDefaultDir={clearDefaultDir}
        onToggleDefaultDirEnabled={toggleDefaultDirEnabled}
        maxLiveSessions={maxLive}
        maxLiveMin={maxLiveMin}
        maxLiveMax={maxLiveMax}
        maxLiveDefault={maxLiveDefault}
        onIncMaxLive={incMaxLive}
        onDecMaxLive={decMaxLive}
        onResetMaxLive={resetMaxLive}
      />
      <CapWarningModal capWarning={capWarning} onDismiss={() => setCapWarnDismissed(true)} />
      <TooltipLayer />
    </div>
  )
}
