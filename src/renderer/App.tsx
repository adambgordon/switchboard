import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AgentKind, ConversationMeta, LiveState, PtyState } from '@shared/types'
import { useSessions } from './lib/useSessions'
import { usePtys } from './lib/usePtys'
import { usePins } from './lib/usePins'
import { useLiveOrder } from './lib/useLiveOrder'
import { useLayout } from './lib/useLayout'
import { useNewConvoDefault } from './lib/useNewConvoDefault'
import { useNewConvoDefaultAgent } from './lib/useNewConvoDefaultAgent'
import { useAgentAvailability } from './lib/useAgentAvailability'
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
import ConversationInfoModal from './components/ConversationInfoModal'
import TooltipLayer from './components/TooltipLayer'

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
  const { order: liveOrder, reorder: reorderLive } = useLiveOrder(liveUnpinnedIds)
  const commitLiveReorder = useCallback(
    (from: number, to: number) => {
      reorderLive(from, to)
      setReorderTick((t) => t + 1)
    },
    [reorderLive]
  )
  const { seen, unread, markUnread, markRead, rekey: rekeySeen } = useSeen()
  const { dir: defaultDir, setDir: setDefaultDir } = useNewConvoDefault()
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

  const { selectedId, open, home, back, forward, rekey: rekeyNav } = useNavHistory()
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
  const [settingsPage, setSettingsPage] = useState<'app' | 'shortcuts' | 'faq' | null>(null)
  // Conversation-info modal target: which session, and whether to open straight into title-edit vs
  // view (both the pane title and the right-click "Session details…" open in view). Null when closed.
  const [infoModal, setInfoModal] = useState<{ sessionId: string; edit: boolean } | null>(null)
  // Section keys revealed past their cap via "Show more" (ephemeral — resets on reload).
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  // Find-in-conversation (main pane). App owns the open/close toggle — ⌘F opens it when focus is
  // in the main pane, Esc closes it; the query + match state live in MainPane. `paneRef` lets the
  // ⌘F handler tell whether focus is physically inside the main pane vs the rail.
  const paneRef = useRef<HTMLElement>(null)
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

  // A provisional new-Codex PTY just got its real rollout id. Migrate every piece of session-keyed
  // state from the placeholder to the real id so the row upgrades IN PLACE — same terminal (it's
  // keyed by ptyId, untouched), now carrying its real identity. rekeyNav swaps the current selection
  // and history stops, so no new history entry is pushed; re-requesting focus keeps the terminal hot
  // through the id change.
  useEffect(() => {
    const off = window.api.onPtyBound((_ptyId, oldId, newId) => {
      if (oldId === newId) return
      rekeyNav(oldId, newId)
      rekeySeen(oldId, newId)
      setViewBySession((prev) => {
        if (!(oldId in prev)) return prev
        const next = { ...prev, [newId]: prev[oldId] }
        delete next[oldId]
        return next
      })
      requestFocus(newId)
    })
    return off
  }, [rekeyNav, rekeySeen, requestFocus])

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
    // Named `unreadCount` (not `unread`) to avoid shadowing the `unread` seen-map from useSeen,
    // referenced as `unread[p.sessionId]` just below. Surfaced as the tally's `unread` field.
    let unreadCount = 0
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
      else if (st === 'awaiting') unreadCount++
      else idle++
    }
    return { count: ptys.active.length, working, asking, unread: unreadCount, idle }
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

  // --- actions: a live process is created ONLY by resume() or startNew() ---
  // Remember a conversation's chosen view so it sticks across navigation.
  const setSessionView = useCallback((id: string, v: View) => {
    setViewBySession((prev) => (prev[id] === v ? prev : { ...prev, [id]: v }))
  }, [])

  // Every landing on a conversation (click / ⌥⌘↑/↓ switch / Enter / resume / new) goes through
  // useNavHistory's `open`, which records a back/forward stop.
  const resume = useCallback(async (meta: ConversationMeta) => {
    open(meta.sessionId)
    setSessionView(meta.sessionId, 'terminal')
    requestFocus(meta.sessionId)
    await window.api.resume(meta.sessionId, meta.cwd, meta.agent, meta.title)
  }, [open, requestFocus, setSessionView])

  const startNew = useCallback(async (cwd: string, agent: AgentKind) => {
    setMenuOpen(false)
    setLastAgent(agent) // starting an agent makes it the sticky menu default too
    const st = await window.api.startNew(cwd, agent)
    open(st.sessionId)
    setSessionView(st.sessionId, 'terminal')
    requestFocus(st.sessionId)
  }, [open, requestFocus, setSessionView])

  const pickOther = useCallback(
    async (agent: AgentKind) => {
      const dir = await window.api.pickDirectory()
      if (dir) await startNew(dir, agent)
    },
    [startNew]
  )

  // The "+" / ⌘N primary action. Spawn straight away only when BOTH axes are settled — a usable
  // default directory AND a resolved agent (a usable default-agent, or the sole installed one). A
  // failed spawn (stale default dir, or the Codex serialize lock) falls back to the menu. Otherwise
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

  const goLive = useCallback(() => {
    if (selectedId) {
      setSessionView(selectedId, 'terminal')
      requestFocus(selectedId)
    }
  }, [selectedId, requestFocus, setSessionView])
  // Enter/focus a live conversation's terminal: record a history stop, switch to the Terminal
  // view, and hand it the keyboard so you can type immediately. The optional `id` lets a switch /
  // click target a row that isn't selected yet; with no arg it acts on `selectedId`. Shared by
  // ⏎ (from Formatted), a live-row click, and the ⌥⌘↑/↓ switch (every call site guards on a live
  // pty, so a not-live selection never lands here).
  const enterLive = useCallback((id?: string) => {
    const target = id ?? selectedId
    if (!target) return
    open(target)
    setSessionView(target, 'terminal')
    requestFocus(target)
  }, [selectedId, open, setSessionView, requestFocus])
  // A live-row CLICK (and the ⌥⌘↑/↓ switch target): open it, switch to its Terminal view, and focus
  // the terminal so you can type immediately. No focus toggle — the main pane always owns the keyboard.
  const clickLive = useCallback((id: string) => enterLive(id), [enterLive])
  // A not-live row CLICK (and the ⌥⌘↑/↓ switch target): open it and hand the keyboard to the
  // Formatted view — parallel to clickLive focusing a live row's terminal. No focus toggle. The
  // synchronous paneRef.focus() lands focus in the pane immediately even before TranscriptView
  // mounts (it then refines focus onto its scroll container) and covers the no-transcript case.
  const clickConversation = useCallback(
    (id: string) => {
      open(id)
      requestFocus(id)
      paneRef.current?.focus({ preventScroll: true })
    },
    [open, requestFocus]
  )
  // ⌥⌘↑/↓ lands on a conversation exactly like a click: a live one drops into its terminal, a
  // not-live one into its Formatted transcript.
  const switchTo = useCallback(
    (id: string) => (ptys.bySession.has(id) ? enterLive(id) : clickConversation(id)),
    [ptys.bySession, enterLive, clickConversation]
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

  // Pin/unpin, gated so a provisional row (no persisted identity yet) can't enter the persisted pin
  // store under a placeholder id that would orphan once it binds to its real id.
  const togglePinGated = useCallback(
    (id: string) => {
      if (!isProvisional(id)) togglePin(id)
    },
    [isProvisional, togglePin]
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
      } else if (mod && e.altKey && (e.code === 'ArrowDown' || e.code === 'ArrowUp')) {
        // ⌥⌘↓ / ⌥⌘↑ — switch to the next / previous conversation (Chrome-tab style) and focus the
        // main pane on it: a live one drops into its terminal (type immediately), a not-live one
        // into its Formatted transcript (⏎ resumes). e.code (not e.key) per the ⌘⌥ Option-key
        // gotcha. Works from inside a live terminal too — Cmd-combos bubble past xterm. Clamps at
        // the ends; from "nothing selected" both directions seed the first row.
        e.preventDefault()
        if (orderedIds.length > 0) {
          const idx = selectedId ? orderedIds.indexOf(selectedId) : -1
          const delta = e.code === 'ArrowDown' ? 1 : -1
          const next = idx < 0 ? 0 : Math.min(orderedIds.length - 1, Math.max(0, idx + delta))
          const nid = orderedIds[next]
          if (nid) switchTo(nid)
        }
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
    newConversation
  ])

  const title = selectedMeta?.title ?? selectedPty?.title ?? 'Conversation'
  const cwd = selectedMeta?.cwd ?? selectedPty?.cwd ?? ''

  // Resolve the info-modal target's meta + live process. A live-but-unindexed session still resolves
  // via the synthesized meta, mirroring the rail.
  const infoPty = infoModal ? ptys.bySession.get(infoModal.sessionId) ?? null : null
  const infoMeta = infoModal
    ? metaById.get(infoModal.sessionId) ?? (infoPty ? synthMeta(infoPty) : null)
    : null

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
            onShowHelp={() => setSettingsPage('shortcuts')}
            onToggleUnread={toggleUnread}
            onMarkUnread={markUnread}
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
            if (selectedId) togglePinGated(selectedId)
          }}
          onResume={() => {
            if (selectedMeta) void resume(selectedMeta)
          }}
          onShowHistory={showHistory}
          onGoLive={goLive}
          onKill={() => {
            if (selectedPty) killSession(selectedPty.ptyId)
          }}
          onShowInfo={() => {
            if (selectedId) showInfo(selectedId, false)
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
        onChooseDefaultDir={chooseDefaultDir}
        onClearDefaultDir={clearDefaultDir}
        agentChoiceAvailable={availableAgents.length >= 2}
        defaultAgentChoice={defaultAgentEnabled ? defaultAgent : 'none'}
        onSetDefaultAgentChoice={setDefaultAgentChoice}
        maxLiveSessions={maxLive}
        maxLiveMin={maxLiveMin}
        maxLiveMax={maxLiveMax}
        maxLiveDefault={maxLiveDefault}
        onSetMaxLive={setMaxLive}
        onResetMaxLive={resetMaxLive}
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
