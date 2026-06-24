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
  /** count of user + assistant messages (excludes meta/attachment lines). */
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
  turnState?: 'in_progress' | 'awaiting' | 'awaiting_input'
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
   * Claude Code session class, read verbatim from the on-disk `sessionKind` field. 'bg' marks a
   * background-job (daemon) session created by `/bg` / `claude --bg`; Claude Code hides those from
   * `/resume`, and the indexer drops them so they never surface as ordinary conversations.
   * Undefined for normal interactive sessions (the field is absent on disk).
   */
  sessionKind?: string
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
 * Renderer-derived liveness of a live session, from the transcript's turn-state plus a local
 * "seen" marker — NOT PTY output activity (a live TUI repaints constantly, so it isn't a turn
 * signal):
 *   working  = Claude is actively producing output / mid-turn
 *   asking   = Claude is blocked on the user's reply (AskUserQuestion / ExitPlanMode), unread
 *   awaiting = the turn finished and the user hasn't looked since
 *   quiet    = live but idle — finished and already seen, or not yet started (nothing happening)
 */
export type LiveState = 'working' | 'asking' | 'awaiting' | 'quiet'

export interface PtyState {
  /** Stable handle for this live process (distinct from sessionId). */
  ptyId: string
  /** The agent session id this PTY is driving. */
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
  origin: 'resume' | 'new'
  exitCode?: number | null
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
  ptySetMaxLive: 'pty:setMaxLive', // renderer -> main: update the live-PTY cap
  ptyData: 'pty:data', // push (ptyId, data)
  ptyExit: 'pty:exit', // push (ptyId, exitCode)
  ptyActiveList: 'pty:activeList',
  ptyActiveChanged: 'pty:activeChanged', // push (PtyState[])
  dialogPickDirectory: 'dialog:pickDirectory',
  openExternal: 'shell:openExternal',
  windowSetBackgroundColor: 'window:setBackgroundColor',
  windowSyncTrafficLights: 'window:syncTrafficLights' // renderer -> main: re-align traffic lights to the current zoom
} as const

/** The typed surface exposed on `window.api` by the preload bridge. */
export interface SwitchboardApi {
  // --- conversations (read-only) ---
  listConversations(): Promise<ConversationGroup[]>
  getTranscript(sessionId: string): Promise<Transcript | null>
  /** Subscribe to live re-indexes (file watcher). Returns an unsubscribe fn. */
  onSessionsChanged(cb: (groups: ConversationGroup[]) => void): () => void
  /**
   * Set a conversation's title by appending Claude Code's own `custom-title` line to its JSONL
   * (the same mechanism as `/rename`) — so the rename is real and survives into `claude --resume`.
   * Pass an empty/whitespace `title` to clear it back to the auto-generated title. Resolves to
   * `true` on success, `false` if the session file can't be found. Main re-indexes immediately,
   * so the new title arrives via `onSessionsChanged` without waiting for the file watcher.
   */
  renameConversation(sessionId: string, title: string): Promise<boolean>

  // --- live sessions (explicit spawn only) ---
  resume(sessionId: string, cwd: string, title?: string): Promise<PtyState>
  startNew(cwd: string): Promise<PtyState>
  sendInput(ptyId: string, data: string): void
  resize(ptyId: string, cols: number, rows: number): void
  kill(ptyId: string): void
  onPtyData(cb: (ptyId: string, data: string) => void): () => void
  onPtyExit(cb: (ptyId: string, exitCode: number | null) => void): () => void
  listActive(): Promise<PtyState[]>
  onActiveChanged(cb: (states: PtyState[]) => void): () => void
  /** Update the main-process live-PTY cap (LRU eviction threshold). Fire-and-forget. */
  setMaxLiveSessions(n: number): void

  // --- misc ---
  pickDirectory(): Promise<string | null>
  openExternal(url: string): void
  /** Match the window's native backgroundColor to the active theme's --paper, so a live resize
   *  fills exposed regions with the right color instead of flashing the other theme. */
  setBackgroundColor(color: string): void
  /** Ask main to re-align the native macOS traffic lights to the current page zoom — fired by the
   *  renderer on every `resize` (which fires on every zoom change). Fire-and-forget. */
  syncTrafficLights(): void

  // --- image input (drag-drop) ---
  // `File` here is the ambient global (DOM File in the renderer, node:buffer File
  // under the node tsconfig) — a type reference, not a DOM import.
  /** Resolve a dropped File to its absolute filesystem path (Electron webUtils). */
  getPathForFile(file: File): string
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
   * Bounds for the user-configurable cap (the Preferences slider clamps to these; the
   * PtyManager re-clamps defensively). 2–14 centers the default (8) on the slider, and the ceiling
   * stays under Chromium's ~16 WebGL-context limit — past which live terminals fall back to the
   * canvas renderer (see TerminalView's onContextLoss).
   */
  liveSessionsMin: 2,
  liveSessionsMax: 14,
  /** ms of output silence after which a live session is considered idle (not busy). */
  busyWindowMs: 800
} as const
