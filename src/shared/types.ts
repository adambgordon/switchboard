import type { NavigationCommand, NavigationVisit } from './navigation'

/**
 * Shared contract between the Electron main process, the preload bridge, and the
 * renderer. This file MUST stay free of any Node or DOM imports so both sides can
 * import it safely.
 */

export type MessageRole = 'user' | 'assistant'

/** Which coding agent produced a conversation. Drives the resume command, the transcript's
 *  assistant label, the row logo, and the agent-specific token breakdown. */
export type AgentKind = 'claude' | 'codex'

export interface AgentInfo {
  /** Display name for chrome (empty state, menus). */
  label: string
  /** Header label for this agent's assistant turns in the Formatted view. */
  assistantLabel: string
}

/** Per-agent display metadata. Logos live in the renderer (keyed by AgentKind) so this file stays
 *  free of any asset/DOM import — both processes import it. */
export const AGENTS: Record<AgentKind, AgentInfo> = {
  claude: { label: 'Claude Code', assistantLabel: 'Claude' },
  codex: { label: 'Codex', assistantLabel: 'Codex' }
}

/** Which agents can actually be SPAWNED — i.e. their CLI is launchable from the login shell (the
 *  GUI app's own PATH is minimal, so this is probed via `$SHELL -lic 'command -v …'`, not
 *  process.env). Browsing existing conversations needs only data on disk; new/resume needs the
 *  binary. Drives the New menu's agent segmented control (auto-collapses to a single agent). */
export type AgentAvailability = Record<AgentKind, boolean>

/** A content block within a message, normalized for read-only rendering. */
export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  | { kind: 'image'; alt: string }

export interface TranscriptMessage {
  uuid: string
  role: MessageRole
  /**
   * For `user` messages, how to attribute the line in the Formatted view:
   * 'human' = a genuinely typed prompt (rendered as "You"); 'tool_result' = tool output
   * the assistant acted on (labeled "Result"/"Error" — NOT "You"); 'interrupted' = the Esc
   * sentinel (rendered as a muted note). Undefined for assistant messages. Non-conversational
   * user lines (slash-command / bash / notification / caveat / meta echo) are dropped during
   * parsing and never reach the renderer.
   */
  userKind?: 'human' | 'tool_result' | 'interrupted'
  blocks: TranscriptBlock[]
  /** ISO 8601, or null if the source line had none. */
  timestamp: string | null
  /** true for sidechain (sub-agent) messages, which we de-emphasize. */
  isSidechain: boolean
}

/** Lightweight metadata for one conversation — what the sidebar list renders. */
/**
 * Coarse state of a conversation's latest turn. Named because both the liveness dot and the
 * live-PTY eviction policy branch on it, and they must branch on the same set of values.
 */
export type TurnState = 'in_progress' | 'awaiting' | 'awaiting_input'

export interface ConversationMeta {
  /** UUID; also the JSONL filename stem and the agent's resume token. */
  sessionId: string
  /** Which agent produced this conversation — drives the resume command, transcript label, row logo. */
  agent: AgentKind
  /** Absolute cwd the session ran in. Read from file CONTENT, never decoded from the dashed dir name. */
  cwd: string
  /** Best human title: aiTitle -> cleaned first user prompt -> "Untitled". */
  title: string
  /** Most recent prompt text, used as the preview line. */
  preview: string
  gitBranch: string | null
  /** ms epoch of last activity (file mtime). */
  mtime: number
  /** Count of visible human/agent prose or image messages; excludes tool plumbing and internal records. */
  messageCount: number
  /** claude version that last wrote the file. */
  version: string | null
  /** size of the session JSONL on disk, in bytes. */
  sizeBytes: number
  /** claude model id the session ran on (last non-synthetic assistant line), or null. */
  model: string | null
  /** cumulative output tokens the agent generated across the conversation. */
  outputTokens: number
  /** cumulative input tokens fed to the model (all input, including any cache/cached reads). */
  inputTokens: number
  /** [Claude] cumulative base (non-cache) input tokens — Anthropic's "Base Input" pricing tier. */
  inputBaseTokens?: number
  /** [Claude] cumulative cache-write tokens (5m + 1h ephemeral creation) — the "Cache Write" pricing tiers. */
  cacheWriteTokens?: number
  /** [Claude] cumulative cache-read tokens (cache hits & refreshes) — the cheapest input tier. */
  cacheReadTokens?: number
  /** [Codex] cumulative cached input tokens (the subset of input served from cache). Codex reports
   *  cached-vs-uncached input, NOT Anthropic's cache-write/cache-read tiers, so it's kept agent-native
   *  and never mapped onto the Claude fields. */
  cachedInputTokens?: number
  /** [Codex] cumulative reasoning output tokens (no Claude on-disk analog). */
  reasoningTokens?: number
  /** [Codex] the model's context-window size (model_context_window) — the denominator for a context
   *  gauge. Claude doesn't persist this on disk, so it's Codex-only. */
  contextWindow?: number
  /** tokens currently in the context window: for Claude, the last main-chain turn's input + cache
   *  (output excluded, matching the status line's used_percentage); for Codex, the last turn's input
   *  (incl. cached). A live snapshot, NOT a cumulative total. 0 before any usage is reported. */
  contextTokens: number
  /** ms epoch of the first user/assistant message (for the elapsed-duration span). Null when none. */
  firstActivityAt: number | null
  /**
   * Coarse state of the latest turn, derived from the transcript tail (main chain only):
   * 'awaiting' = the last assistant turn ended (awaiting the user); 'in_progress' = a turn
   * is mid-flight (a dangling tool_use, or a trailing user / tool_result); 'awaiting_input' =
   * the turn is parked on a tool that blocks for the user's reply (AskUserQuestion /
   * ExitPlanMode). Undefined when there are no messages yet. Drives the live dot's
   * working/asking/awaiting/quiet split.
   */
  turnState?: TurnState
  /** ms epoch when the last turn ended (assistant end_turn / turn_duration), or null. */
  turnEndedAt?: number | null
  /**
   * ms epoch of the last real (user/assistant) message — the true "last activity",
   * unlike `mtime`, which resume and metadata writes (mode/permission-mode/ai-title) bump
   * without any conversational turn.
   */
  lastActivityAt?: number | null
  /**
   * When `turnState === 'awaiting_input'`, which blocking tool parked the turn:
   * 'AskUserQuestion' (Claude asked you a question) or 'ExitPlanMode' (Claude asked you to
   * approve a plan). Null/undefined otherwise. Lets the renderer tell the two apart if it
   * wants; today both resolve to the single 'asking' live state.
   */
  awaitingTool?: 'AskUserQuestion' | 'ExitPlanMode' | null
  /**
   * Claude Code session class, read verbatim from the on-disk `sessionKind` field. 'bg' marks an
   * independently resumable background transcript and surfaces as its own labeled row; internal
   * 'daemon' / 'daemon-worker' sessions are omitted. Undefined for normal interactive sessions.
   */
  sessionKind?: string
  /**
   * Codex thread class, read verbatim from `session_meta.payload.thread_source`. 'subagent' marks a
   * delegated agent thread; the indexer drops those so only the parent conversation surfaces.
   * Undefined for Claude and older Codex rollouts that predate the field.
   */
  threadSource?: string
  /** Codex delegation identified from session metadata, including guardian reviews. */
  codexSubagent?: boolean
  /** true when this is a freshly-started session with no persisted history yet. */
  provisional?: boolean
}

/** Full transcript payload for the preview pane. */
export interface Transcript {
  sessionId: string
  /** Which agent produced it — drives the per-agent assistant label in the Formatted view. */
  agent: AgentKind
  cwd: string
  title: string
  messages: TranscriptMessage[]
}

/** Conversations grouped by exact cwd (the sidebar's primary structure). */
export interface ConversationIndexSnapshot {
  groups: ConversationGroup[]
  hiddenSessionIds: string[]
}

export interface ConversationGroup {
  /** Absolute cwd; the grouping key. */
  cwd: string
  /** Display label (typically the basename, with full path available on hover). */
  label: string
  conversations: ConversationMeta[]
  /** Most recent mtime in the group, for ordering sections by recency. */
  latestMtime: number
}

/** Runtime state of a live PTY-backed session. */
export type PtyStatus = 'busy' | 'idle' | 'exited'

/**
 * Why a Codex PTY's sessionId changed — the two cases need OPPOSITE renderer handling, and the
 * difference is not inferable from the ids themselves.
 *
 * The line that decides it is CONVERSATION-owned state versus TERMINAL-owned state:
 *  - conversation-owned — persisted seen/unread markers, and EARLIER history stops — belongs to the
 *    id itself. Earlier stops were genuine visits to a conversation that still exists.
 *  - terminal-owned — the current selection, the CURRENT history stop, the surface that selection is
 *    showing, and the row's Live slot — describes the terminal in front of the user, and follows it.
 *    Main retargets the current app-wide visit after the focused corrected tab's adoption commits;
 *    earlier visits retain their original conversation.
 *
 * - `initial`: a provisional PTY's throwaway placeholder was replaced by its real rollout id. The
 *   placeholder names no conversation and is about to cease existing, so there is no conversation-owned
 *   state to protect: EVERYTHING keyed to it migrates, or it is orphaned.
 * - `correction`: a bound PTY was proven to be running a DIFFERENT conversation than the one it
 *   claimed. Both ids name durable conversations — the old one still exists and reappears in Recent,
 *   the new one may already carry its own state — so conversation-owned state does NOT move; moving it
 *   would delete one conversation's read state and overwrite the other's. Terminal-owned state still
 *   follows, and the selection and its surface do so only when the user is actually on that terminal.
 *
 * Main knows which happened; the renderer must be told rather than guess from whether the old id
 * happens to be indexed, which is also true of a real conversation in the moment before it indexes.
 */
export type PtyBindKind = 'initial' | 'correction'

/**
 * Renderer-derived liveness of a live session, from the transcript's turn-state plus a local
 * "seen" marker — NOT PTY output activity (a live TUI repaints constantly, so it isn't a turn
 * signal):
 *   working  = the agent is actively producing output / mid-turn
 *   asking   = the agent is blocked on the user's reply, unread
 *   awaiting = the turn finished and the user hasn't looked since
 *   quiet    = live but idle — finished and already seen, or not yet started (nothing happening)
 */
export type LiveState = 'working' | 'asking' | 'awaiting' | 'quiet'

/** A live terminal as `PtyManager` tracks it — lifecycle only, no notion of windows. */
export interface PtySession {
  /** Stable handle for this live process (distinct from sessionId). */
  ptyId: string
  /** The conversation Switchboard associated with this PTY at launch (or Codex late-bind). */
  sessionId: string
  /** Which agent this PTY is running (drives the boot command). */
  agent: AgentKind
  cwd: string
  title: string
  status: PtyStatus
  /** ms epoch of last output byte. */
  lastActivity: number
  /** ms epoch when the process was spawned. */
  startedAt: number
  /**
   * ms epoch of the newest explicit Codex OSC notification that requests user input, or null.
   * Transcript activity newer than this supersedes it; generic PTY output never sets it.
   */
  inputRequestedAt: number | null
  origin: 'resume' | 'new'
  /**
   * True while this PTY has no PROVEN conversation identity: a new Codex session whose rollout hasn't
   * been matched to it yet (Codex mints its own id, so `sessionId` is still a placeholder). Codex-only
   * — Claude sessions are launched with an id Switchboard chose, so they are never provisional.
   *
   * The renderer must not present a provisional row's transcript, title, or liveness as known: binding
   * requires exact OS evidence and deliberately fails closed, so this can stay true for the life of
   * the terminal. Distinct from the renderer's own `isProvisional` (meta-absence), which also covers a
   * new Claude session in the ~1s before its JSONL indexes.
   */
  provisional: boolean
  /**
   * [Claude] The background agent this session has launched, or null. Its presence means ONLY that —
   * Claude writes the marker on spawn and never clears it, so it says nothing about whether the
   * terminal is currently showing that agent. Paired with "this session has no indexed conversation"
   * it identifies a terminal whose work went into the agent rather than its own transcript, which
   * otherwise renders as an empty "New conversation" row while the user is working in it.
   */
  parkedJob: { shortId: string; name: string } | null
  exitCode?: number | null
}

/**
 * A live terminal as the renderer sees it: the session above, plus which window may render it.
 *
 * The split is deliberate. `PtyManager` owns terminal LIFECYCLE and knows nothing about windows — it
 * emits bytes without a destination. The window layer in `ipc.ts` routes them only to the owner and
 * stamps that per-recipient answer here; it is also the only place that can know the spawning IPC
 * sender.
 */
export interface PtyState extends PtySession {
  /**
   * Whether THIS window may mount an xterm for this terminal.
   *
   * A terminal has exactly one owner across the whole app, and this is what enforces it. Two windows
   * rendering the same terminal would each fit their own geometry and push it to the pty, which has a
   * single size: the loser reflows the agent's output to the wrong width and — because a terminal only
   * re-pushes when its OWN pixel size changes — never recovers. So a non-owning window shows that
   * conversation's transcript and offers to take the terminal over, rather than racing for it.
   *
   * Deliberately a boolean answered PER WINDOW rather than an owner id the renderer compares against
   * its own: the live set is sent to each window separately with this already resolved, so there is no
   * identity for a renderer to get wrong, and no need for it to know its own window at all.
   *
   * True for the window that spawned it; moved only by an explicit `IPC.ptyClaim`.
   */
  ownedHere: boolean
}

/** A self-contained xterm state transfer. The VT payload is produced by SerializeAddon and must be
 * replayed at the captured geometry before the destination fits itself to a new pane. */
export interface PtySnapshot {
  data: string
  cols: number
  rows: number
  /** How many rows the viewport was above the bottom, clamped by the retained serialized scrollback. */
  viewportFromBottom: number
}

/** IPC channel identifiers. invoke/handle unless noted as a main->renderer push. */
export const IPC = {
  sessionsList: 'sessions:list',
  sessionsGet: 'sessions:get',
  sessionsRename: 'sessions:rename', // renderer -> main: set/clear a conversation's custom title
  sessionsChanged: 'sessions:changed', // push
  ptyResume: 'pty:resume',
  ptyStartNew: 'pty:startNew',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyFlowPause: 'pty:flowPause',
  ptyFlowResume: 'pty:flowResume',
  ptySetMaxLive: 'pty:setMaxLive', // renderer -> main: update the live-PTY cap
  ptyVisible: 'pty:visible', // renderer -> main: which terminals this window has on screen
  ptyUsed: 'pty:used', // renderer -> main: a person actually typed/pasted into this terminal
  ptyData: 'pty:data', // push (ptyId, data)
  ptyExit: 'pty:exit', // push (ptyId, exitCode)
  ptyBound: 'pty:bound', // per-window push (ptyId, oldSessionId, newSessionId, kind, ownedHere, adoptionToken)
  ptyActiveList: 'pty:activeList',
  ptyActiveChanged: 'pty:activeChanged', // push (PtyState[])
  agentsAvailable: 'agents:available', // which agent CLIs are launchable from the login shell (cached)
  dialogPickDirectory: 'dialog:pickDirectory',
  openExternal: 'shell:openExternal',
  linkContextMenu: 'shell:linkContextMenu', // renderer -> main: pop the native right-click menu for a link
  codeContextMenu: 'shell:codeContextMenu', // renderer -> main: pop the native right-click menu for inline code
  tabContextMenu: 'shell:tabContextMenu', // renderer -> main: pop the native right-click menu for a tab; resolves with the chosen action
  menuCloseTab: 'menu:closeTab', // push: ⌘W — the renderer closes the active tab, or asks main to close the window when there is none
  windowClose: 'window:close', // renderer -> main: close the sender's window (⌘W with no tab to close)
  windowOpenConversation: 'window:openConversation', // renderer -> main: open a NEW window with an ordered tab group
  // Dragging a tab between windows. While a mouse button is held the OS routes every move to the
  // window the drag STARTED in, so the window under the cursor never learns the pointer is there —
  // main is the only party that can see all the windows, so it referees. It reads the cursor on
  // demand (never on a timer) and only while a drag is actually in flight.
  tabDragBegin: 'tab:dragBegin', // renderer -> main: a tab-group drag started here
  tabDragHover: 'tab:dragHover', // renderer -> main: resolve which window the cursor is over now
  tabDragDrop: 'tab:dragDrop', // renderer -> main: released; resolves with what became of the tab
  tabDragCancel: 'tab:dragCancel', // renderer -> main: the source window handled it itself
  tabDragOver: 'tab:dragOver', // push: this window is under a tab drag from elsewhere
  tabDragLeave: 'tab:dragLeave', // push: it no longer is
  tabDropHere: 'tab:dropHere', // push (TabDragPayload): adopt this ordered tab group
  // One conversation holds ONE tab across the whole app. Only main can see every window, so it keeps
  // the register of which window holds what and answers the two questions a renderer cannot: "is this
  // open somewhere else" and "then show it / hand it over".
  tabsChanged: 'tab:changed', // renderer -> main: the full set of conversations this window has tabs for
  tabWorkspaceChanged: 'tab:workspaceChanged', // renderer -> main: restart-safe pane membership/order/active tabs
  tabWorkspaceActivate: 'tab:workspaceActivate', // renderer -> main: retrieve the dormant primary layout
  tabWorkspaceActivated: 'tab:workspaceActivated', // renderer -> main: primary applied; open dormant satellites
  tabWorkspaceClear: 'tab:workspaceClear', // renderer -> main: explicit feature disable clears all saved layouts
  tabsElsewhere: 'tab:elsewhere', // push (sessionIds): conversations OTHER windows hold tabs for
  conversationReveal: 'tab:reveal', // renderer -> main: focus the window holding this and show its tab
  conversationResume: 'tab:resume', // renderer -> main: resume in the window already holding the tab
  conversationClaim: 'tab:claim', // renderer -> main: tell that window to give the tab up
  tabActivate: 'tab:activate', // push (NavigationCommand): apply a tagged visit or history replay
  navigationReport: 'navigation:report', // renderer -> main: committed view and whether it is a visit
  navigationStep: 'navigation:step', // renderer -> main: step the app-wide cursor
  navigationInterrupt: 'navigation:interrupt', // renderer -> main: a local user action supersedes playback
  navigationComplete: 'navigation:complete', // renderer -> main: tagged activation committed
  navigationCancelled: 'navigation:cancelled', // push (requestId): discard superseded activation
  tabResume: 'tab:resumeHere', // push (sessionId): resume the tab in this window
  tabRelease: 'tab:release', // push (sessionId): close your tab for this conversation
  tabShouldRelease: 'tab:shouldRelease', // renderer -> main: confirm a queued release is still current
  tabReserveBound: 'tab:reserveBound', // renderer -> main: validate a corrected PTY before retargeting
  tabCommitBound: 'tab:commitBound', // renderer -> main: adoption committed; claim its tab
  tabCancelBound: 'tab:cancelBound', // renderer -> main: adoption was abandoned
  ptyClaim: 'pty:claim', // renderer -> main: take ownership of a terminal from another window
  ptySnapshotRequest: 'pty:snapshotRequest', // push (requestId, ptyId): owner serializes after draining writes
  ptySnapshotReply: 'pty:snapshotReply', // renderer -> main (requestId, ptyId, snapshot|null)
  ptySnapshotStage: 'pty:snapshotStage', // push (ptyId, snapshot): destination stages before ownership flips
  ptySnapshotRestored: 'pty:snapshotRestored', // renderer -> main: destination replay completed; repaint foreground TUI
  windowSetBackgroundColor: 'window:setBackgroundColor',
  windowSyncTrafficLights: 'window:syncTrafficLights', // renderer -> main: re-align traffic lights to the current zoom
  windowSetDockIcon: 'window:setDockIcon', // renderer -> main: swap the macOS dock icon (light / dark variant)
  windowIsFocused: 'window:isFocused', // renderer -> main: seed the focus flag on mount
  windowFocusChanged: 'window:focusChanged', // push (focused) — OS window focus/blur
  appRefreshStart: 'app:refreshStart', // push: ⌘R refresh begun — renderer covers the window with the white veil
  appRefreshEnd: 'app:refreshEnd', // push: ⌘R refresh restored — renderer fades the veil back out
  updatesGetInfo: 'updates:getInfo', // build version/sha + whether this copy can self-update
  updatesCheck: 'updates:check', // compare the build commit to main via Git
  updatesCheckStateGet: 'updates:checkStateGet',
  updatesCheckStateChanged: 'updates:checkStateChanged', // push (UpdateCheckState)
  updatesRun: 'updates:run', // git pull + npm run setup in the source repo
  updatesProgress: 'updates:progress', // push (line) — streamed update output
  updatesRunStateGet: 'updates:runStateGet',
  updatesRunStateChanged: 'updates:runStateChanged', // push (UpdateRunState)
  updatesRelaunch: 'updates:relaunch' // renderer -> main: quit + relaunch into the rebuilt app
} as const

/** Build identity + whether this copy can rebuild itself. */
export interface UpdateInfo {
  /** package.json version baked into the bundle (app.getVersion()). */
  version: string
  /** Full commit the build was packaged from, or 'dev' for an unpackaged run. */
  sha: string
  /** First 7 of `sha` (or 'dev') — for display. */
  shaShort: string
  /** Absolute path to the source repo when this build can rebuild itself, else null (e.g. the .app
   *  was moved out of its dist/ folder). null → the UI offers the manual command instead of Update. */
  repoRoot: string | null
  /** false for `npm run dev`; the in-app update only operates on the packaged .app. */
  packaged: boolean
}

/** Result of comparing the build's baked commit to `main`'s tip SHA (via `git ls-remote`). Binary:
 *  'behind' means an update exists — git smart-HTTP yields the tip SHA only, not a commit count. */
export type UpdateCheck =
  | { status: 'current' }
  | { status: 'behind' }
  | { status: 'unknown'; reason: string }

export interface UpdateCheckState {
  check: UpdateCheck | null
  checking: boolean
}

/** What the native tab context menu resolved to. */
export type TabMenuAction =
  | 'close'
  | 'closeOthers'
  | 'details'
  | 'splitRight'
  | 'moveRight'
  | 'moveLeft'
  | 'newWindow'

/** What became of a tab group released outside its own window's strips. See `tabDragDrop`. */
export type TabDropOutcome = 'moved' | 'detached' | 'cancelled'

/** The tabs carried by one drag, in source-strip order, and the tab under the pointer. */
export interface TabDragPayload {
  sessionIds: string[]
  activeSessionId: string
}

/** Restart-safe tab state. Runtime pane ids and preview status are deliberately excluded. */
export interface PersistedTabPane {
  sessionIds: string[]
  activeSessionId: string | null
}

export interface PersistedTabLayout {
  panes: PersistedTabPane[]
}

/** Whether navigating to a conversation should replace the preview slot or make its tab stick. */
export type TabOpenMode = 'preview' | 'persistent'

/** What a freshly-created window should show. Passed synchronously through `additionalArguments`,
 *  parsed by the preload, and exposed as `window.sbWindow` before the first renderer frame. */
export interface WindowInit {
  /**
   * The conversations to open as this window's tabs — empty for an ordinary browser window.
   *
   * A list rather than a single id because a multi-selection moved to a new window belongs in ONE
   * window holding all of them, not one window each.
   */
  sessionIds: string[]
  /** The tab the user dragged or invoked the command on. Null in an ordinary browser window. */
  activeSessionId: string | null
  /** A layout restored from the previous app run; null for an ordinary or newly-detached window. */
  restoredTabs: PersistedTabLayout | null
  /** The first browser window persists shared rail layout; detached windows never do. */
  primary: boolean
  /**
   * Start with the left rail hidden. A detached window is a working surface for one conversation, so
   * it opens without the browser — ⌘B brings it back. It is a starting state, not a mode: the choice
   * is deliberately NOT persisted from such a window, because layout lives in localStorage and is
   * shared by every window of the app.
   */
  collapseRail: boolean
}


/** Terminal result of an in-app update run (git pull + npm run setup). */
export interface UpdateRunResult {
  ok: boolean
  code: number | null
}

export type UpdateRunPhase = 'idle' | 'updating' | 'done' | 'failed'

export interface UpdateRunState {
  phase: UpdateRunPhase
  log: string
}

/** The typed surface exposed on `window.api` by the preload bridge. */
export interface SwitchboardApi {
  // --- conversations (read-only) ---
  listConversations(): Promise<ConversationIndexSnapshot>
  getTranscript(sessionId: string, revision: string): Promise<Transcript | null>
  /** Subscribe to live re-indexes (file watcher). Returns an unsubscribe fn. */
  onSessionsChanged(cb: (snapshot: ConversationIndexSnapshot) => void): () => void
  /**
   * Set a conversation's title by appending Claude Code's own `custom-title` line to its JSONL
   * (the same mechanism as `/rename`) — so the rename is real and survives into `claude --resume`.
   * Pass an empty/whitespace `title` to clear it back to the auto-generated title. Resolves to
   * `true` on success, `false` if the session file can't be found. Main re-indexes immediately,
   * so the new title arrives via `onSessionsChanged` without waiting for the file watcher.
   */
  renameConversation(sessionId: string, title: string): Promise<boolean>

  // --- live sessions (explicit spawn only) ---
  resume(sessionId: string, cwd: string, agent: AgentKind, title?: string): Promise<PtyState>
  /**
   * Start a NEW session for `agent` in `cwd`. Claude gets a pre-assigned id and is live immediately;
   * Codex mints its own rollout id, so the returned PtyState is `provisional` (placeholder id) until
   * the OS can prove which rollout that terminal is running, at which point `onPtyBound` fires. That
   * proof may never arrive — binding requires exact evidence and fails closed — so a PTY can stay
   * provisional for its whole life. Rejects if `cwd` is gone. Several unbound new-Codex sessions may
   * coexist: each is identified independently, so there is no serialization between them.
   */
  startNew(cwd: string, agent: AgentKind): Promise<PtyState>
  sendInput(ptyId: string, data: string): void
  resize(ptyId: string, cols: number, rows: number): void
  kill(ptyId: string): void
  /** Backpressure for renderer write queues. Main combines this window's pause with transfer pauses. */
  setPtyOutputPaused(ptyId: string, paused: boolean): void
  onPtyData(cb: (ptyId: string, data: string) => void): () => void
  onPtyExit(cb: (ptyId: string, exitCode: number | null) => void): () => void
  /** A Codex PTY's sessionId changed from `oldSessionId` to `newSessionId` (same `ptyId`).
   *  `kind` is load-bearing and must not be inferred — see `PtyBindKind`. Returns an unsubscribe fn. */
  onPtyBound(
    cb: (
      ptyId: string,
      oldSessionId: string,
      newSessionId: string,
      kind: PtyBindKind,
      ownedHere: boolean,
      /** Only the initial placeholder's tab owner receives a token to confirm or reject adoption. */
      adoptionToken: string | null
    ) => void
  ): () => void
  listActive(): Promise<PtyState[]>
  onActiveChanged(cb: (states: PtyState[]) => void): () => void
  /** Update the main-process live-PTY cap (LRU eviction threshold). Fire-and-forget. */
  setMaxLiveSessions(n: number): void
  /** Report which terminals this window currently has on screen, so they are never reclaimed. */
  reportVisiblePtys(ptyIds: string[]): void
  /** Report that a person typed, pasted or dropped into this terminal (throttled by the caller). */
  reportTerminalUsed(ptyId: string): void
  /** Which agent CLIs are launchable from the login shell. Probed once in main and cached. */
  listAgents(): Promise<AgentAvailability>

  // --- misc ---
  pickDirectory(): Promise<string | null>
  openExternal(url: string): void
  /** Pop the NATIVE macOS context menu for a transcript link (Copy Link / Open Link in Browser).
   *  Native rather than an in-app menu so the fonts, theme, and dismissal are the OS's, not ours. */
  linkContextMenu(url: string): void
  /** Pop the NATIVE macOS context menu for an inline code span (Copy Code). Same reasoning as above,
   *  and the same one-gesture-one-payload intent: the code, without its backticks. */
  codeContextMenu(code: string): void
  /** Pop the NATIVE macOS context menu for a tab and resolve with the chosen action (null if
   *  dismissed). Native for the same reasons as the two above, plus one specific to a strip: an OS
   *  menu is not anchored to a DOM node, so the strip scrolling out from under it cannot close it.
   *  `closeOthers` / `details` gate the items that would otherwise be offered as no-ops. */
  tabContextMenu(opts: {
    /** How many tabs the chosen command will act on — 1 unless a multi-selection is in effect and the
     *  right-clicked tab belongs to it. Labels are pluralised from this, so a group action cannot read
     *  as a single-tab one. */
    count: number
    closeOthers: boolean
    details: boolean
    /**
     * Sending the tab sideways, as three mutually exclusive offers. Which one applies is the
     * renderer's call, since only it knows the layout — and they are named for what actually happens:
     * `splitRight` CREATES the second pane, while `moveRight` / `moveLeft` move between panes that
     * already exist. Calling the latter "Split" would promise a split that is already there.
     */
    splitRight: boolean
    moveRight: boolean
    moveLeft: boolean
    newWindow: boolean
  }): Promise<TabMenuAction | null>
  /** ⌘W: main pushes this to the focused window, which closes its active tab — or calls
   *  `closeWindow()` when it has none, so the shortcut still behaves like macOS expects. Returns an
   *  unsubscribe fn. */
  onMenuCloseTab(cb: () => void): () => void
  /** Close the window this renderer belongs to. The ⌘W fallback, and what makes a detached window
   *  closable from inside. */
  closeWindow(): void
  /** Open a NEW window showing this ordered tab group, with the rail hidden. Fire-and-forget. */
  openConversationWindow(payload: TabDragPayload): void

  // ---- dragging a tab between windows ----
  /** Tell main a tab-group drag started here, so it can referee where the cursor goes. */
  tabDragBegin(payload: TabDragPayload): void
  /** Ask main to re-resolve which window the cursor is over, and to move the drop highlight there.
   *  Called at most once per animation frame, and only while dragging. */
  tabDragHover(): void
  /**
   * The pointer was released outside this window's own strips. Main decides from the cursor:
   *  - `moved` — another window took the group; the caller must now close its copies.
   *  - `detached` — no window was under the cursor, so a new one opened with it; also close ours.
   *  - `cancelled` — the cursor was still over this window, so nothing happened.
   */
  tabDragDrop(): Promise<TabDropOutcome>
  /** The source window handled the drop itself (it landed on one of its own strips). */
  tabDragCancel(): void
  /** This window is under a tab drag from another one — show that it can receive it. */
  onTabDragOver(cb: () => void): () => void
  onTabDragLeave(cb: () => void): () => void
  /** Adopt an ordered tab group dragged in from another window. */
  onTabDropHere(cb: (payload: TabDragPayload) => void): () => void

  // ---- one tab per conversation, across every window ----
  /** Report the full set of conversations this window holds tabs for. Sent whenever that set changes,
   *  so main can keep its register without tracking individual opens and closes. */
  tabsChanged(sessionIds: string[]): void
  /** Persist this window's restart-safe tab layout, or clear it when tabs are disabled/empty. */
  persistTabLayout(layout: PersistedTabLayout | null): void
  /** Retrieve this window's dormant saved layout when the feature is enabled after launch. */
  activateTabWorkspace(): Promise<PersistedTabLayout | null>
  /** Confirm the primary layout is active so main may open saved satellite windows. */
  finishTabWorkspaceActivation(): void
  /** Explicitly switching the feature off clears active and dormant saved layouts. */
  clearTabWorkspace(): void
  /** The conversations OTHER windows hold tabs for. Lets this window decide locally — and
   *  synchronously — whether an open should reveal rather than duplicate. */
  onTabsElsewhere(cb: (sessionIds: string[]) => void): () => void
  /** Focus the window holding this conversation and bring its tab forward. For an implicit open ("show
   *  me this"), where the tab already exists and should not be relocated. */
  revealConversation(sessionId: string, mode: TabOpenMode): void
  /** Route Resume to the window already holding the conversation's tab. */
  resumeConversationElsewhere(sessionId: string): void
  /** Ask whichever window holds this conversation to give its tab up, because this window is about to
   *  place it. For an explicit placement, where relocating IS what was asked for. */
  claimConversation(sessionId: string): void
  /** Another window asked for our tab to be shown. */
  onTabActivate(cb: (command: NavigationCommand) => void): () => void
  reportNavigation(visit: NavigationVisit | null, record: boolean, revision: number): void
  stepNavigation(direction: -1 | 1): void
  interruptNavigation(revision: number): void
  completeNavigation(requestId: number, visit: NavigationVisit | null): void
  onNavigationCancelled(cb: (requestId: number) => void): () => void
  onTabResume(cb: (sessionId: string) => void): () => void
  /** Another window is taking this conversation — close our tab for it. */
  onTabRelease(cb: (sessionId: string) => void): () => void
  /** Recheck a queued release against main's current owner before closing the local tab. */
  shouldReleaseTab(sessionId: string): Promise<boolean>
  /** Reserve a corrected tab after main validates this window's PTY ownership and identity. */
  reserveBoundTab(ptyId: string, oldSessionId: string, sessionId: string): Promise<string | null>
  commitBoundTab(token: string): void
  cancelBoundTab(token: string): void
  /** Take ownership of a terminal currently owned by another window, so this one can show it. Main
   *  transfers a drained xterm snapshot before changing ownership. */
  claimTerminal(ptyId: string): Promise<boolean>
  /** Main asks the current owner for a drained, self-contained terminal snapshot. */
  onPtySnapshotRequest(cb: (requestId: string, ptyId: string) => void): () => void
  replyPtySnapshot(requestId: string, ptyId: string, snapshot: PtySnapshot | null): void
  /** Stage a snapshot synchronously before the ownership update that mounts its destination xterm. */
  onPtySnapshotStage(cb: (ptyId: string, snapshot: PtySnapshot) => void): () => void
  /** Confirm staged state reached xterm; main then asks the foreground process for a complete repaint. */
  confirmPtySnapshotRestored(ptyId: string): void
  /** Match the window's native backgroundColor to the active theme's --paper, so a live resize
   *  fills exposed regions with the right color instead of flashing the other theme. */
  setBackgroundColor(color: string): void
  /** Ask main to re-align the native macOS traffic lights to the current page zoom — fired by the
   *  renderer on every `resize` (which fires on every zoom change). Fire-and-forget. */
  syncTrafficLights(): void
  /** ⌘R refresh lifecycle pushes: `start` fires before the zoom wiggle (renderer covers the window with
   *  a white veil), `end` after the zoom is restored (renderer fades the veil out), so the relayout is
   *  hidden. Also used for the launch fade-in. Each returns an unsubscribe fn. */
  onRefreshStart(cb: () => void): () => void
  onRefreshEnd(cb: () => void): () => void
  /** Swap the macOS dock icon to the light or dark variant (a Preferences toggle, independent of the
   *  light/dark THEME). Fire-and-forget; the renderer re-pushes the saved choice on mount, since a
   *  packaged dock resets to the bundled .icns each launch. No-op off macOS. */
  setDockIcon(dark: boolean): void
  /** Current OS focus state of the window, for seeding on mount. Main is the SOLE authority on
   *  window focus: the renderer must not derive it from `document.hasFocus()`, which can disagree
   *  with the window's actual state. */
  isWindowFocused(): Promise<boolean>
  /** Subscribe to window focus/blur (main -> renderer push). Returns an unsubscribe fn. */
  onWindowFocusChanged(cb: (focused: boolean) => void): () => void

  // --- image input (drag-drop) ---
  // `File` here is the ambient global (DOM File in the renderer, node:buffer File
  // under the node tsconfig) — a type reference, not a DOM import.
  /** Resolve a dropped File to its absolute filesystem path (Electron webUtils). */
  getPathForFile(file: File): string

  // --- self-update ---
  /** Build version/sha + whether this copy can rebuild itself (source repo findable, packaged). */
  getUpdateInfo(): Promise<UpdateInfo>
  /** Compare the build's commit to the latest on `main`; forced checks bypass the settled cache. */
  checkForUpdates(force?: boolean): Promise<UpdateCheck>
  getUpdateCheckState(): Promise<UpdateCheckState>
  onUpdateCheckState(cb: (state: UpdateCheckState) => void): () => void
  /** Run `git pull --ff-only <https> main && npm run setup` in the source repo, streaming output via
   *  onUpdateProgress. Resolves when it finishes (ok=false on any failure, or in a dev run). */
  runUpdate(): Promise<UpdateRunResult>
  /** Streamed stdout/stderr lines from an in-flight runUpdate. Returns an unsubscribe fn. */
  onUpdateProgress(cb: (line: string) => void): () => void
  getUpdateRunState(): Promise<UpdateRunState>
  onUpdateRunState(cb: (state: UpdateRunState) => void): () => void
  /** Quit and relaunch into the freshly-built .app (after a successful runUpdate). */
  relaunchForUpdate(): void
}

/** Config knobs shared across processes. */
export const CONFIG = {
  /**
   * DEFAULT max concurrent live PTYs before LRU eviction of the least-recently-used IDLE one.
   * User-configurable at runtime: the renderer persists the chosen value and pushes it to the
   * PtyManager via IPC.ptySetMaxLive (see useMaxLiveSessions). This is the fallback used before
   * the renderer pushes a value, and the hook's default.
   */
  maxLivePtys: 8,
  /**
   * Bounds for the user-configurable cap (the Preferences slider clamps to these; the PtyManager
   * re-clamps defensively). The range is deliberately ASYMMETRIC about the default — 6 below, 8 above —
   * so the slider maps it piecewise to keep the default mid-track (see lib/maxLiveScale.ts). An earlier
   * 2–14 got that centering for free from symmetry, which is the only reason it was 14.
   *
   * The ceiling now REACHES Chromium's ~16 WebGL-context limit rather than staying under it. That's a
   * soft edge, not a cliff: at the top of the range the oldest live terminals lose their GL context and
   * fall back to the canvas renderer (see TerminalView's onContextLoss), which costs some of the repaint
   * smoothness WebGL was adopted for. The Preferences tooltip already frames high values as
   * increase-at-your-own-risk.
   */
  liveSessionsMin: 2,
  liveSessionsMax: 16,
  /** ms of output silence after which a live session is considered idle (not busy). */
  busyWindowMs: 800
} as const
