import {
  app,
  clipboard,
  ipcMain,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  nativeImage,
  powerMonitor,
  screen,
  webContents,
  type MenuItemConstructorOptions
} from 'electron'
import os from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  IPC,
  type AgentAvailability,
  type AgentKind,
  type ConversationIndexSnapshot,
  type PersistedTabLayout,
  type PtyBindKind,
  type PtySnapshot,
  type PtySession,
  type PtyState,
  type TabDragPayload,
  type TabDropOutcome,
  type TabMenuAction,
  type TabOpenMode,
  type UpdateRunState,
  type WindowInit
} from '../shared/types'
import { parseTabDragPayload } from '../shared/tabDrag'
import { EMPTY_SESSION_INDEX, retainHiddenSessions, visibleTabDrag } from '../shared/sessionVisibility'
import { appendUpdateLog } from '../shared/updateLog'
import {
  BoundTabReservations,
  retireInitialTabClaim,
  canReserveTabForBoundPty,
  claimWindowTabs,
  reconcileWindowTabs,
  shouldReleaseTab
} from './tabOwnership'
import { transferPty } from './pty/transfer'
import { indexConversations, type MetaCache } from './sessions/indexer'
import { parseTranscript } from './sessions/parser'
import { parsePiTranscript, resolvePiFile } from './sessions/piParser'
import { parseCodexTranscript, resolveCodexFile } from './sessions/codexParser'
import { appendCustomTitle } from './sessions/rename'
import { renameCodexThread } from './sessions/codexRename'
import { SessionWatcher } from './sessions/watcher'
import { PtyManager } from './pty/manager'
import { syncTrafficLights } from './trafficLights'
import { buildInfo, checkForUpdates, runUpdate, relaunchForUpdate } from './updater'
import { singleFlight } from './updater-core'
import { UpdateChecks } from './updateChecks'
import { LatestTask } from './latestTask'
import { TranscriptLoader, type TranscriptSource } from './transcriptLoader'
import { loadTabWorkspace, TabWorkspaceStore } from './tabWorkspaceStore'
import { NavigationCoordinator } from './navigation'
import type { NavigationVisit } from '../shared/navigation'

const PROJECTS_ROOT = join(os.homedir(), '.claude', 'projects')

let watcher: SessionWatcher | null = null
let mgr: PtyManager | null = null
let liveTick: ReturnType<typeof setInterval> | null = null
let tabWorkspace: TabWorkspaceStore | null = null

export function initializeTabWorkspace(
  userDataDir: string,
  file?: string
): PersistedTabLayout | null {
  const restored = loadTabWorkspace(userDataDir, file)
  tabWorkspace = new TabWorkspaceStore(
    userDataDir,
    file,
    restored,
    (sessionId) => tabOwner.get(sessionId)
  )
  tabWorkspace.excludeSessions(hiddenSessionIds)
  return tabWorkspace.takePrimary()
}

export function registerTabWindow(webContentsId: number, layout: PersistedTabLayout | null): void {
  if (layout) tabWorkspace?.register(webContentsId, layout)
}

export function flushTabWorkspace(): void {
  tabWorkspace?.flush()
}

// --- the window layer ---------------------------------------------------------------------------
//
// `PtyManager` owns terminal lifecycle and knows nothing about windows. Everything below routes its
// bytes to one renderer and owns cross-window placement, which only this module can know because the
// spawning window is the IPC sender.

/**
 * ptyId → the webContents id of the window allowed to mount an xterm for it.
 *
 * Exactly one owner per terminal, app-wide. Two windows rendering the same terminal would each fit
 * their own geometry and push it to a pty that has a single size; the loser then renders the agent's
 * output at the wrong width and never recovers, because a terminal only re-pushes when its own pixel
 * size changes. A non-owning window shows the transcript and offers to take the terminal over.
 */
const ptyOwner = new Map<string, number>()

/** Supplied by `index.ts`, which owns geometry and first-window bookkeeping. */
let openWindow: ((init?: WindowInit) => BrowserWindow) | null = null

export function setWindowOpener(fn: (init?: WindowInit) => BrowserWindow): void {
  openWindow = fn
}

/**
 * The tab drag currently in flight, if any — main's whole share of cross-window dragging.
 *
 * `hoveringId` is which window is currently showing the "you can drop here" state, so it can be told
 * to stop when the cursor moves on. Held here rather than in either renderer because neither can see
 * the other: the OS gives the source window mouse capture for the duration.
 */
let tabDrag: { sourceId: number; payload: TabDragPayload; hoveringId: number | null } | null = null

/**
 * Which window holds the tab for each conversation.
 *
 * One conversation holds one tab across the whole app, and no renderer can enforce that alone — a
 * window can see its own panes and nothing else. Main keeps the register instead, built from each
 * window reporting its full set on change rather than from individual opens and closes: a set is
 * idempotent, so a dropped or reordered message cannot leave the register describing tabs that no
 * longer exist. Same shape as `ptyOwner` above, and released by the same hook.
 */
const tabOwner = new Map<string, number>()
/** Eager claims protected from stale target reports until that target first reports the tab. */
const pendingTabClaims = new Map<string, number>()
let hiddenSessionIds: ReadonlySet<string> = new Set()
const boundTabReservations = new BoundTabReservations()

const navigation = new NavigationCoordinator({
  ownerOf: (sessionId) => tabOwner.get(sessionId),
  exists: (windowId) => {
    const contents = webContents.fromId(windowId)
    return !!contents && !contents.isDestroyed()
  },
  activate: (windowId, command) => { sendToWindow(windowId, IPC.tabActivate, command) },
  cancel: (windowId, requestId) => { sendToWindow(windowId, IPC.navigationCancelled, requestId) },
  focus: (windowId) => {
    const contents = webContents.fromId(windowId)
    if (contents && !contents.isDestroyed()) BrowserWindow.fromWebContents(contents)?.focus()
  },
  restoreTerminal: (windowId, sessionId, current) => {
    const pty = mgr?.findBySession(sessionId)
    if (!pty) return Promise.resolve(false)
    return transferTerminal(pty.ptyId, windowId, () =>
      current() && mgr?.findBySession(sessionId)?.ptyId === pty.ptyId
    )
  }
})

export function navigationWindowFocused(windowId: number): void {
  navigation.focused(windowId)
}

const SNAPSHOT_TIMEOUT_MS = 1000
const pendingSnapshots = new Map<
  string,
  {
    ownerId: number
    ptyId: string
    timer: ReturnType<typeof setTimeout>
    resolve: (snapshot: PtySnapshot | null) => void
  }
>()

let updateRunState: UpdateRunState = { phase: 'idle', log: '' }

function claimTabsForWindow(windowId: number, sessionIds: string[]): void {
  const releases = claimWindowTabs(tabOwner, windowId, sessionIds.filter((id) => !hiddenSessionIds.has(id)), pendingTabClaims)
  for (const { ownerId, sessionId } of releases) sendToWindow(ownerId, IPC.tabRelease, sessionId)
  emitTabsElsewhere()
}

/** Tell every window which conversations the OTHERS hold, so each can decide locally. */
function emitTabsElsewhere(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    const mine = w.webContents.id
    const elsewhere: string[] = []
    for (const [sessionId, owner] of tabOwner) {
      if (owner !== mine) elsewhere.push(sessionId)
    }
    // Per-recipient rather than broadcast: "elsewhere" means something different to each window, so
    // there is no one message to send. Mirrors `emitActive`, and for the same reason.
    w.webContents.send(IPC.tabsElsewhere, elsewhere)
  }
}

function setWindowTabs(wcId: number, sessionIds: string[]): void {
  const releases = reconcileWindowTabs(tabOwner, wcId, sessionIds.filter((id) => !hiddenSessionIds.has(id)), pendingTabClaims)
  for (const { ownerId, sessionId } of releases) sendToWindow(ownerId, IPC.tabRelease, sessionId)
  emitTabsElsewhere()
}

function sendToWindow(wcId: number | null, channel: string, ...args: unknown[]): boolean {
  if (wcId == null) return false
  const target = webContents.fromId(wcId)
  if (!target || target.isDestroyed()) return false
  target.send(channel, ...args)
  return true
}

function requestPtySnapshot(ownerId: number, ptyId: string): Promise<PtySnapshot | null> {
  return new Promise((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pendingSnapshots.delete(requestId)
      resolve(null)
    }, SNAPSHOT_TIMEOUT_MS)
    pendingSnapshots.set(requestId, { ownerId, ptyId, timer, resolve })
    if (!sendToWindow(ownerId, IPC.ptySnapshotRequest, requestId, ptyId)) {
      clearTimeout(timer)
      pendingSnapshots.delete(requestId)
      resolve(null)
    }
  })
}

async function transferTerminal(
  ptyId: string,
  targetId: number,
  current: () => boolean = () => true
): Promise<boolean> {
  if (!current() || !mgr?.list().some((s) => s.ptyId === ptyId)) return false
  const ownerId = ptyOwner.get(ptyId)
  const reason = `transfer:${randomUUID()}`
  return transferPty(ownerId, targetId, {
    pause: () => mgr!.setOutputPaused(ptyId, reason, true),
    resume: () => mgr!.setOutputPaused(ptyId, reason, false),
    capture: () => requestPtySnapshot(ownerId!, ptyId),
    stage: (snapshot) => current() && sendToWindow(targetId, IPC.ptySnapshotStage, ptyId, snapshot),
    commit: () => {
      ptyOwner.set(ptyId, targetId)
      if (ownerId != null) mgr!.setOutputPaused(ptyId, `renderer:${ownerId}`, false)
      emitActive()
    },
    repaintUnowned: () => mgr!.repaint(ptyId)
  })
}

function emitUpdateRunState(): void {
  broadcast(IPC.updatesRunStateChanged, updateRunState)
}

const runUpdateOnce = singleFlight(async () => {
  updateChecks.setPaused(true)
  updateRunState = { phase: 'updating', log: '' }
  emitUpdateRunState()
  const result = await runUpdate((line) => {
    updateRunState = { ...updateRunState, log: appendUpdateLog(updateRunState.log, line) }
    broadcast(IPC.updatesProgress, line)
  })
  updateRunState = { ...updateRunState, phase: result.ok ? 'done' : 'failed' }
  updateChecks.setPaused(result.ok)
  emitUpdateRunState()
  return result
})

const updateChecks = new UpdateChecks(
  checkForUpdates,
  (state) => broadcast(IPC.updatesCheckStateChanged, state),
  { periodic: app.isPackaged && process.env.SWITCHBOARD_SMOKE !== '1' }
)
const onUpdateCheckWake = (): void => updateChecks.wake()

function endTabDrag(): void {
  if (!tabDrag) return
  sendToWindow(tabDrag.hoveringId, IPC.tabDragLeave)
  tabDrag = null
}

/**
 * A visible window containing the cursor, or null when none does.
 *
 * The cursor position is asked of the OS rather than taken from the pointer event: `screenX/screenY`
 * is in the renderer's CSS pixels, and this app zooms (⌘+/−), so those coordinates and a window's DIP
 * bounds part company at any zoom but 100%. `getCursorScreenPoint` shares the bounds' space.
 *
 * `excludeId` is load-bearing, and the reason is that **`getAllWindows` does not promise z-order** —
 * Electron exposes no z-order for all windows. Detached windows are cascaded off the first
 * one, so they overlap it: hit-testing in creation order finds the SOURCE window under the cursor and
 * concludes the drag never left it, which made every cross-window drop cancel. The source renderer
 * knows the one thing main cannot — whether the pointer is still inside its own viewport — so when it
 * says the pointer is out, that window is excluded from the test entirely rather than guessed about.
 */
function windowUnderCursor(excludeId?: number): BrowserWindow | null {
  const { x, y } = screen.getCursorScreenPoint()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) continue
    if (excludeId != null && w.webContents.id === excludeId) continue
    const b = w.getBounds()
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return w
  }
  return null
}

/** Whether the cursor is within one specific window's bounds. */
function cursorInWindow(wcId: number): boolean {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.id === wcId)
  if (!w || w.isDestroyed()) return false
  const { x, y } = screen.getCursorScreenPoint()
  const b = w.getBounds()
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
}

/**
 * A window closed. Its claims are released so a surviving window can take those terminals over —
 * without this a live session whose window was closed would stay unreachable for the rest of the run,
 * still running, with no window permitted to show it.
 */
export function releaseWindow(webContentsId: number, preserveTabs = false): void {
  mgr?.releaseOutputPause(`renderer:${webContentsId}`)
  for (const [requestId, pending] of pendingSnapshots) {
    if (pending.ownerId !== webContentsId) continue
    clearTimeout(pending.timer)
    pendingSnapshots.delete(requestId)
    pending.resolve(null)
  }
  let released = false
  for (const [ptyId, owner] of ptyOwner) {
    if (owner === webContentsId) {
      ptyOwner.delete(ptyId)
      released = true
    }
  }
  // A drag whose source window is gone can never be dropped or cancelled by it, so it would otherwise
  // leave another window stuck showing the drop highlight forever.
  if (tabDrag && (tabDrag.sourceId === webContentsId || tabDrag.hoveringId === webContentsId)) {
    endTabDrag()
  }
  // A closed window's tabs are gone with it. Without this the register keeps claiming it holds them,
  // and every surviving window would refuse to open those conversations — revealing into a window
  // that no longer exists.
  let forgot = false
  for (const [sessionId, owner] of tabOwner) {
    if (owner === webContentsId) {
      tabOwner.delete(sessionId)
      forgot = true
    }
  }
  for (const [sessionId, targetId] of pendingTabClaims) {
    if (targetId === webContentsId) pendingTabClaims.delete(sessionId)
  }
  boundTabReservations.discardWindow(webContentsId)
  if (forgot) emitTabsElsewhere()
  navigation.closed(webContentsId)
  tabWorkspace?.close(webContentsId, preserveTabs)
  if (released) emitActive()
}

/** Move live terminals out of a normally-closing window while its renderer can still serialize them. */
export async function prepareWindowClose(webContentsId: number): Promise<void> {
  if (!mgr) return
  const survivors = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && w.webContents.id !== webContentsId
  )
  if (survivors.length === 0) return
  const survivorIds = new Set(survivors.map((w) => w.webContents.id))
  const fallback = BrowserWindow.getFocusedWindow()
  const fallbackId =
    fallback && survivorIds.has(fallback.webContents.id)
      ? fallback.webContents.id
      : survivors[0].webContents.id
  const sessions = new Map(mgr.list().map((s) => [s.ptyId, s]))
  const transfers: Promise<boolean>[] = []
  for (const [ptyId, ownerId] of ptyOwner) {
    if (ownerId !== webContentsId) continue
    const session = sessions.get(ptyId)
    const tabWindow = session ? tabOwner.get(session.sessionId) : undefined
    const targetId = tabWindow != null && survivorIds.has(tabWindow) ? tabWindow : fallbackId
    transfers.push(transferTerminal(ptyId, targetId))
  }
  await Promise.all(transfers)
}

/** Resolve ownership FROM ONE WINDOW'S POINT OF VIEW, so the renderer gets a boolean it can act on
 *  rather than an id it has to compare against its own. */
function forWindow(sessions: PtySession[], webContentsId: number): PtyState[] {
  return sessions.map((s) => ({ ...s, ownedHere: ptyOwner.get(s.ptyId) === webContentsId }))
}

/**
 * Push the current live set to every window, each with its own ownership view.
 *
 * Deliberately NOT `broadcast`, which sends one identical payload: `ownedHere` is per-recipient by
 * construction, so one shared payload could not express it.
 */
function emitActive(): void {
  if (!mgr) return
  const sessions = mgr.list()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(IPC.ptyActiveChanged, forWindow(sessions, w.webContents.id))
    }
  }
}

/** Persistent per-file meta cache shared across every re-index, so the frequent live-turn poll
 *  re-parses only the transcript(s) actually changing rather than re-reading the whole index each
 *  pass (387 MB+ of transcripts on a busy machine). See indexer's MetaCache / extractWithCache. */
const metaCache: MetaCache = new Map()
/** Signature of the last broadcast group tree, so reindexAndBroadcast can skip pushing an identical
 *  snapshot — the poll's 2.5s idle tail, Codex's flat (lazy-flush) periods, and the watcher's
 *  post-write re-fire after a rename all otherwise re-broadcast unchanged data. */
let lastBroadcastSig: string | null = null

/**
 * Live turn-state poll: while a live session has produced output recently, re-index every
 * LIVE_TICK_MS to keep the working/asking/awaiting dot current. Codex flushes its rollout lazily and
 * clusters writes near turn boundaries, so the file watcher's change events can arrive only once a
 * turn is already complete; polling reads the open `in_progress` state sitting on disk.
 *
 * We keep polling for LIVE_INDEX_WINDOW_MS after the LAST output byte (not just while strictly
 * "busy"), so the turn-END marker — which Codex writes a beat after the visible output stops — is
 * caught by this fast poll instead of waiting on the slower watcher path (which is what left the dot
 * breathing ~2-3s too long). A truly idle session (no output for the window) still costs nothing.
 */
const LIVE_TICK_MS = 500
const LIVE_INDEX_WINDOW_MS = 2500

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

const conversationIndex = new LatestTask(
  async () => retainHiddenSessions(await indexConversations(PROJECTS_ROOT, undefined, metaCache), hiddenSessionIds),
  (snapshot) => {
    const { groups } = snapshot
    if (snapshot.hiddenSessionIds.length !== hiddenSessionIds.size) {
      hiddenSessionIds = new Set(snapshot.hiddenSessionIds)
      navigation.setHiddenSessions(hiddenSessionIds)
      tabWorkspace?.excludeSessions(hiddenSessionIds)
      for (const id of hiddenSessionIds) {
        tabOwner.delete(id)
        pendingTabClaims.delete(id)
      }
      emitTabsElsewhere()
    }
    // Keep every live Codex terminal's identity honest: a new rollout only lands on disk at its first
    // turn, which is exactly when this re-index fires (the live session goes active). Hand the manager
    // the eligible rollout ids so it can ask the OS which one the Codex process in each terminal
    // actually has open. `groups` is already fully filtered, so archived / non-interactive /
    // zero-message / subagent rollouts can never be bind targets. This both binds a terminal that had
    // no identity and corrects one that has since drifted onto another conversation; either emits
    // `bound` + `active-changed`, so the row re-labels in place and the rollout isn't also shown as a
    // separate Recent conversation.
    //
    // Deliberately NOT awaited, and deliberately ABOVE the identical-groups early return: the probe
    // shells out to lsof, which must never delay the session-list broadcast, and a pass whose groups
    // are byte-identical to the last one is still a pass where a rollout may have just become
    // observable — returning early before scheduling it would strand exactly the case this fixes.
    // The hasCodexToProbe() gate keeps the id set from being built when no Codex session is live at
    // all; this function runs twice a second while anything is live. The manager itself is what stays
    // quiet once every terminal is confirmed, so a settled app does no lsof work.
    if (mgr?.hasCodexToProbe()) {
      const eligibleCodexIds = new Set(
        groups
          .flatMap((g) => g.conversations)
          .filter((c) => c.agent === 'codex')
          .map((c) => c.sessionId)
      )
      void mgr.probeCodexIdentity(eligibleCodexIds)
    }
    const sig = JSON.stringify(snapshot)
    if (sig !== lastBroadcastSig) {
      lastBroadcastSig = sig
      broadcast(IPC.sessionsChanged, snapshot)
    }
  }
)

/** Re-index both agents' sessions and push the result to the renderer. Swallows transient fs errors. */
function reindexAndBroadcast(queueIfRunning = true): Promise<ConversationIndexSnapshot> {
  return conversationIndex
    .refresh(queueIfRunning)
    .catch(() => conversationIndex.peek() ?? EMPTY_SESSION_INDEX)
}

async function transcriptSource(sessionId: string): Promise<TranscriptSource | null> {
  const claudePath = await resolveSessionFile(sessionId)
  if (claudePath) return { agent: 'claude', path: claudePath }
  const codexPath = await resolveCodexFile(sessionId)
  if (codexPath) return { agent: 'codex', path: codexPath }
  const piPath = await resolvePiFile(sessionId)
  return piPath ? { agent: 'pi', path: piPath } : null
}

const transcriptLoader = new TranscriptLoader(
  transcriptSource,
  (source) => source.agent === 'claude'
    ? parseTranscript(source.path)
    : source.agent === 'pi' ? parsePiTranscript(source.path) : parseCodexTranscript(source.path)
)

/**
 * Which agent CLIs are launchable, probed via the LOGIN+INTERACTIVE shell (`$SHELL -lic`) — the same
 * shell the PtyManager spawns, so this reflects the real PATH a session would get, not the GUI app's
 * minimal process.env. `command -v` prints the resolved path for each that exists and nothing for
 * those that don't (exiting non-zero when one is missing — expected, so we ignore the error and parse
 * stdout). Probed once and cached; the in-flight promise is shared so concurrent callers don't double-probe.
 */
let agentAvailability: AgentAvailability | null = null
let agentAvailabilityProbe: Promise<AgentAvailability> | null = null

function probeAgents(): Promise<AgentAvailability> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(shell, ['-lic', 'command -v claude; command -v codex; command -v pi'], { timeout: 4000 }, (_err, stdout) => {
      const lines = (typeof stdout === 'string' ? stdout : '').split('\n').map((l) => l.trim())
      const has = (name: string): boolean => lines.some((l) => l === name || l.endsWith('/' + name))
      resolve({ claude: has('claude'), codex: has('codex'), pi: has('pi') })
    })
  })
}

function listAgents(): Promise<AgentAvailability> {
  if (agentAvailability) return Promise.resolve(agentAvailability)
  if (!agentAvailabilityProbe) {
    agentAvailabilityProbe = probeAgents().then((a) => {
      agentAvailability = a
      return a
    })
  }
  return agentAvailabilityProbe
}

/** Resolve a sessionId to its JSONL path. The filename stem IS the sessionId. */
async function resolveSessionFile(sessionId: string): Promise<string | null> {
  if (!/^[a-f0-9-]{8,}$/i.test(sessionId)) return null
  try {
    const dirs = await readdir(PROJECTS_ROOT)
    for (const d of dirs) {
      const p = join(PROJECTS_ROOT, d, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
  } catch {
    /* projects root may not exist */
  }
  return null
}

/** Open an http(s) URL in the system browser; ignore anything else. */
export function openExternalUrl(url: string): void {
  if (/^https?:\/\//.test(url)) shell.openExternal(url)
}

/**
 * Pop the native context menu for a transcript link. Native (rather than an in-app menu like the
 * conversation-row one) because macOS already draws this correctly in both themes, flips it near the
 * screen edge, and dismisses it properly — and because an OS menu isn't anchored to a DOM node, so the
 * transcript's own scroll churn can't close it. (The rail's custom menu has a comment about exactly
 * that: a document-wide scroll listener was slammed shut by the transcript re-pinning on open.)
 *
 * COPY IS UNGATED, OPEN IS NOT. Writing to the clipboard is inert, so any href a transcript carries can
 * be copied — that's what makes a file path useful here. Launching is the dangerous half: the http(s)
 * gate on Open is what stops transcript content, which the agent wrote rather than the user, from
 * turning the app into a launcher for arbitrary schemes or local executables.
 */
export function popLinkContextMenu(url: string, win: BrowserWindow | null): void {
  if (!url) return
  const openable = /^https?:\/\//.test(url)
  // A bare path (relative, absolute, or ~-rooted) has no URL scheme; anything with one reads as a link.
  const isPath = !/^[a-z][a-z0-9+.-]*:/i.test(url)
  const items: MenuItemConstructorOptions[] = [
    { label: isPath ? 'Copy Path' : 'Copy Link', click: () => clipboard.writeText(url) }
  ]
  if (openable) {
    items.push(
      { type: 'separator' },
      { label: 'Open Link in Browser', click: () => openExternalUrl(url) }
    )
  }
  Menu.buildFromTemplate(items).popup(win ? { window: win } : undefined)
}

/**
 * Pop the native context menu for an inline code span. Native for the same reasons as the link menu
 * above; unlike that one it needs no scheme gating, because writing to the clipboard is inert and there
 * is no launching half.
 *
 * The payload is the code WITHOUT its backticks, and deliberately without regard to the "Copy as
 * markdown" preference. A selection can express either intent — the markers travel or they don't,
 * depending on where its ends fall — but this gesture can only mean one thing.
 */
export function popCodeContextMenu(code: string, win: BrowserWindow | null): void {
  if (!code) return
  Menu.buildFromTemplate([
    { label: 'Copy Code', click: () => clipboard.writeText(code) }
  ]).popup(win ? { window: win } : undefined)
}

/**
 * Pop the NATIVE context menu for a tab and resolve with what was chosen (null if dismissed).
 * Native for the same reasons as the link and code menus above, plus one specific to a strip: an OS
 * menu isn't anchored to a DOM node, so the strip scrolling out from under it cannot close it.
 *
 * Resolution is settle-once. A click resolves immediately with its action; the close callback
 * resolves `null` only if nothing was picked, and is deferred a tick because the ordering of a menu
 * item's `click` against the popup's close callback is not something to rely on.
 *
 * No accelerator is attached to Close Tab here even though ⌘W performs it. A popup-menu accelerator
 * would register a second binding for a chord the File menu already owns; the label alone is enough,
 * and the item is reached by pointer anyway.
 */
export function popTabContextMenu(
  opts: {
    count: number
    closeOthers: boolean
    details: boolean
    splitRight: boolean
    moveRight: boolean
    moveLeft: boolean
    newWindow: boolean
  },
  win: BrowserWindow | null
): Promise<TabMenuAction | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (action: TabMenuAction | null): void => {
      if (settled) return
      settled = true
      resolve(action)
    }
    const pick = (action: TabMenuAction) => () => finish(action)
    // Every label counts its targets, so a command that will act on a whole selection says so. The
    // suffix is empty for one tab, which keeps the ordinary menu reading exactly as it did.
    const n = Math.max(1, opts.count)
    const many = n > 1
    const tabs = many ? `${n} Tabs` : 'Tab'
    const items: MenuItemConstructorOptions[] = [
      { label: `Close ${tabs}`, click: pick('close') }
    ]
    if (opts.closeOthers) items.push({ label: 'Close Other Tabs', click: pick('closeOthers') })
    // Where a tab can be sent. Hidden rather than disabled when it does not apply, matching `details`
    // and the row menu: a control that silently does nothing is worse than an absent one. The label
    // says what will actually happen — "Split" only when a pane is about to be created, "Move" when
    // both already exist.
    if (opts.splitRight || opts.moveRight || opts.moveLeft || opts.newWindow) {
      items.push({ type: 'separator' })
      if (opts.splitRight) items.push({ label: 'Split Right', click: pick('splitRight') })
      if (opts.moveRight) items.push({ label: 'Move Right', click: pick('moveRight') })
      if (opts.moveLeft) items.push({ label: 'Move Left', click: pick('moveLeft') })
      if (opts.newWindow) {
        // Singular window either way: a group moves into ONE new window, not one each.
        items.push({
          label: many ? `Move ${n} Tabs to New Window` : 'Move to New Window',
          click: pick('newWindow')
        })
      }
    }
    if (opts.details) {
      items.push({ type: 'separator' }, { label: 'Session Details…', click: pick('details') })
    }
    Menu.buildFromTemplate(items).popup({
      ...(win ? { window: win } : {}),
      callback: () => setTimeout(() => finish(null), 0)
    })
  })
}

export function registerIpc(): void {
  mgr = new PtyManager({
    claudeParkedJobs: { sessionsRoot: join(os.homedir(), '.claude', 'sessions') }
  })
  mgr.on('data', (ptyId: string, data: string) =>
    sendToWindow(ptyOwner.get(ptyId) ?? null, IPC.ptyData, ptyId, data)
  )
  mgr.on('exit', (ptyId: string, code: number | null) => {
    boundTabReservations.discardPty(ptyId)
    ptyOwner.delete(ptyId)
    broadcast(IPC.ptyExit, ptyId, code)
  })
  mgr.on('active-changed', () => emitActive())
  // A Codex PTY's sessionId changed. `kind` must be forwarded: it tells the renderer whether this
  // replaced a placeholder (everything keyed to it migrates) or corrected a terminal onto a different
  // real conversation (CONVERSATION-owned state — persisted seen/unread, earlier history stops —
  // stays put, while terminal-owned state — selection, current stop, surface, Live slot — follows the
  // terminal). See PtyBindKind.
  mgr.on('bound', (ptyId: string, oldId: string, newId: string, kind: PtyBindKind) => {
    boundTabReservations.discardPty(ptyId)
    const tabWindow = retireInitialTabClaim(
      tabOwner,
      kind,
      oldId,
      newId,
      pendingTabClaims
    )
    const adoptionToken = tabWindow == null ? null : randomUUID()
    if (adoptionToken && tabWindow != null) {
      boundTabReservations.reserve(adoptionToken, {
        windowId: tabWindow, ptyId, sessionId: newId, fromSessionId: null
      })
    }
    if (kind === 'initial') navigation.rekey(oldId, newId)
    if (kind === 'initial') emitTabsElsewhere()
    const terminalOwner = ptyOwner.get(ptyId)
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      w.webContents.send(
        IPC.ptyBound,
        ptyId,
        oldId,
        newId,
        kind,
        terminalOwner === w.webContents.id,
        tabWindow === w.webContents.id ? adoptionToken : null
      )
    }
  })

  // Warm the agent-availability probe now so the first New-menu open is instant (it's cached).
  void listAgents()

  // --- conversations (read-only) ---
  ipcMain.handle(IPC.sessionsList, () => conversationIndex.get().catch(() => ({ ...EMPTY_SESSION_INDEX, hiddenSessionIds: [...hiddenSessionIds] })))
  ipcMain.handle(IPC.sessionsGet, async (_e, sessionId: string, revision: string) => {
    await conversationIndex.get()
    if (hiddenSessionIds.has(sessionId)) return null
    const transcript = await transcriptLoader.load(sessionId, revision)
    return hiddenSessionIds.has(sessionId) ? null : transcript
  })
  // Set/clear a conversation's title, then re-index + broadcast IMMEDIATELY so the new title lands in
  // the UI now rather than when the watcher/poll next fires. Dispatch by agent: a Claude session has a
  // JSONL file (we append its own `custom-title` line); otherwise it's Codex — the sessionId IS the
  // app-server threadId, and the rename writes Codex's own DB (`threads.title`), which the re-index's
  // title read then surfaces (the rollout is untouched).
  ipcMain.handle(IPC.sessionsRename, async (_e, sessionId: string, title: string): Promise<boolean> => {
    await conversationIndex.get()
    if (hiddenSessionIds.has(sessionId)) return false
    if (await resolvePiFile(sessionId)) return false // Rename inside Pi to preserve its live tree.
    const claudeFp = await resolveSessionFile(sessionId)
    try {
      if (hiddenSessionIds.has(sessionId)) return false
      if (claudeFp) await appendCustomTitle(claudeFp, sessionId, title)
      else await renameCodexThread(sessionId, title.trim())
      await reindexAndBroadcast()
      return true
    } catch {
      return false
    }
  })

  // --- live sessions (explicit spawn only) ---
  // The spawning window owns the terminal it started. That is the only implicit assignment; every
  // later move is an explicit claim.
  ipcMain.handle(IPC.ptyResume, async (e, sessionId: string, cwd: string, agent: AgentKind, title?: string) => {
    await conversationIndex.get()
    if (hiddenSessionIds.has(sessionId)) throw new Error('This conversation is hidden')
    const existing = mgr!.findBySession(sessionId)
    if (existing) {
      await transferTerminal(existing.ptyId, e.sender.id, () => !hiddenSessionIds.has(sessionId))
      return forWindow([existing], e.sender.id)[0]
    }
    const piFile = agent === 'pi' ? await resolvePiFile(sessionId) : undefined
    if (agent === 'pi' && !piFile) throw new Error('Pi session no longer exists')
    const st = mgr!.resume(sessionId, cwd, agent, title, (spawned) => {
      ptyOwner.set(spawned.ptyId, e.sender.id)
    }, piFile ?? undefined)
    return forWindow([st], e.sender.id)[0]
  })
  ipcMain.handle(IPC.ptyStartNew, (e, cwd: string, agent: AgentKind) => {
    // Guard a stale default folder: if it's been deleted/renamed since it was chosen in Preferences,
    // reject so the renderer can fall back to the chooser instead of node-pty throwing on a bad cwd.
    if (!existsSync(cwd)) throw new Error(`Directory no longer exists: ${cwd}`)
    const st = mgr!.startNew(cwd, agent, (spawned) => {
      ptyOwner.set(spawned.ptyId, e.sender.id)
    })
    return forWindow([st], e.sender.id)[0]
  })
  ipcMain.handle(IPC.ptyClaim, (e, ptyId: string) => transferTerminal(ptyId, e.sender.id, () => {
    const pty = mgr?.list().find((p) => p.ptyId === ptyId)
    return !!pty && !hiddenSessionIds.has(pty.sessionId)
  }))
  ipcMain.on(
    IPC.ptySnapshotReply,
    (e, requestId: string, ptyId: string, snapshot: PtySnapshot | null) => {
      const pending = pendingSnapshots.get(requestId)
      if (!pending || pending.ownerId !== e.sender.id || pending.ptyId !== ptyId) return
      clearTimeout(pending.timer)
      pendingSnapshots.delete(requestId)
      pending.resolve(snapshot)
    }
  )
  ipcMain.on(IPC.ptySnapshotRestored, (e, ptyId: string) => {
    if (ptyOwner.get(ptyId) === e.sender.id) mgr!.repaint(ptyId)
  })
  ipcMain.on(IPC.ptyInput, (e, ptyId: string, data: string) => {
    if (ptyOwner.get(ptyId) === e.sender.id) mgr!.write(ptyId, data)
  })
  ipcMain.on(IPC.ptyResize, (e, ptyId: string, cols: number, rows: number) => {
    if (ptyOwner.get(ptyId) === e.sender.id) mgr!.resize(ptyId, cols, rows)
  })
  ipcMain.on(IPC.ptyKill, (_e, ptyId: string) => mgr!.kill(ptyId))
  ipcMain.on(IPC.ptyFlowPause, (e, ptyId: string) => {
    if (ptyOwner.get(ptyId) === e.sender.id) {
      mgr!.setOutputPaused(ptyId, `renderer:${e.sender.id}`, true)
    }
  })
  ipcMain.on(IPC.ptyFlowResume, (e, ptyId: string) => {
    if (ptyOwner.get(ptyId) === e.sender.id) {
      mgr!.setOutputPaused(ptyId, `renderer:${e.sender.id}`, false)
    }
  })
  ipcMain.on(IPC.ptySetMaxLive, (_e, n: number) => mgr!.setMaxLive(n))
  ipcMain.handle(IPC.ptyActiveList, (e) => forWindow(mgr!.list(), e.sender.id))
  ipcMain.handle(IPC.agentsAvailable, () => listAgents())

  // --- misc ---
  ipcMain.handle(IPC.dialogPickDirectory, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a directory for the new conversation'
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })
  ipcMain.on(IPC.openExternal, (_e, url: string) => openExternalUrl(url))
  ipcMain.on(IPC.linkContextMenu, (e, url: string) =>
    popLinkContextMenu(url, BrowserWindow.fromWebContents(e.sender))
  )
  ipcMain.on(IPC.codeContextMenu, (e, code: string) =>
    popCodeContextMenu(code, BrowserWindow.fromWebContents(e.sender))
  )
  ipcMain.handle(
    IPC.tabContextMenu,
    (
      e,
      opts: {
        count: number
        closeOthers: boolean
        details: boolean
        splitRight: boolean
        moveRight: boolean
        moveLeft: boolean
        newWindow: boolean
      }
    ) => popTabContextMenu(opts, BrowserWindow.fromWebContents(e.sender))
  )
  // ---- dragging a tab between windows ----
  // The referee. While a mouse button is held the OS delivers every move to the window the drag began
  // in, so no other window can see the pointer over itself; main is the only party that can. It reads
  // the cursor ON DEMAND — never on a timer — and only between dragBegin and drop/cancel.
  ipcMain.on(IPC.tabDragBegin, (e, value: unknown) => {
    const parsed = parseTabDragPayload(value)
    const payload = parsed ? visibleTabDrag(parsed, hiddenSessionIds) : null
    if (!payload) return
    tabDrag = { sourceId: e.sender.id, payload, hoveringId: null }
  })
  // Resolved from the cursor and window bounds alone. An earlier version asked the source renderer
  // whether the pointer had left its own viewport and only looked for a target when it said yes — which
  // breaks precisely where it matters: a detached window is CASCADED off the one that spawned it, so
  // the two overlap, and a pointer over the second is still inside the first's rectangle. The answer
  // came back "no", and every cross-window drop cancelled.
  //
  // So: the source is excluded from the search, and any OTHER window containing the cursor wins. The
  // one case this reads wrongly is a source window sitting ON TOP of another and the release landing
  // over its own body — that resolves to the window underneath. The drop highlight appears on whichever
  // window would receive it, before the button comes up, so the guess is at least visible.
  ipcMain.on(IPC.tabDragHover, (e) => {
    if (!tabDrag || tabDrag.sourceId !== e.sender.id) return
    const target = windowUnderCursor(tabDrag.sourceId)
    const id = target ? target.webContents.id : null
    if (id === tabDrag.hoveringId) return
    sendToWindow(tabDrag.hoveringId, IPC.tabDragLeave)
    tabDrag.hoveringId = id
    sendToWindow(id, IPC.tabDragOver)
  })
  ipcMain.handle(IPC.tabDragDrop, (e): TabDropOutcome => {
    const drag = tabDrag
    endTabDrag()
    if (!drag || drag.sourceId !== e.sender.id) return 'cancelled'
    const payload = visibleTabDrag(drag.payload, hiddenSessionIds)
    if (!payload) return 'cancelled'
    const target = windowUnderCursor(drag.sourceId)
    if (target) {
      claimTabsForWindow(target.webContents.id, payload.sessionIds)
      target.webContents.send(IPC.tabDropHere, payload)
      navigation.reveal(e.sender.id, payload.activeSessionId, 'persistent')
      return 'moved'
    }
    // No other window under the cursor. Over the source's own body means the user released somewhere
    // that is not a strip, which does nothing; over the desktop is the detach gesture.
    if (cursorInWindow(drag.sourceId)) return 'cancelled'
    const opened = openWindow?.({
      ...payload,
      restoredTabs: null,
      primary: false,
      collapseRail: true
    })
    if (opened) claimTabsForWindow(opened.webContents.id, payload.sessionIds)
    return 'detached'
  })
  ipcMain.on(IPC.tabDragCancel, () => endTabDrag())

  // ---- one tab per conversation, across every window ----
  ipcMain.on(IPC.tabsChanged, (e, sessionIds: string[]) => {
    if (!Array.isArray(sessionIds)) return
    setWindowTabs(
      e.sender.id,
      sessionIds.filter((id): id is string => typeof id === 'string' && !!id)
    )
  })
  ipcMain.on(IPC.tabWorkspaceChanged, (e, layout: unknown) => {
    tabWorkspace?.update(e.sender.id, layout)
  })
  ipcMain.handle(IPC.tabWorkspaceActivate, (e) => tabWorkspace?.layoutFor(e.sender.id) ?? null)
  ipcMain.on(IPC.tabWorkspaceActivated, async (e) => {
    const layouts = await tabWorkspace?.takeDormant(
      conversationIndex.get(),
      () => mgr !== null && !e.sender.isDestroyed()
    )
    for (const layout of layouts ?? []) {
      openWindow?.({
        sessionIds: [],
        activeSessionId: null,
        restoredTabs: layout,
        primary: false,
        collapseRail: true
      })
    }
  })
  ipcMain.on(IPC.tabWorkspaceClear, () => tabWorkspace?.clear())
  // "Show me this" for a conversation another window already holds: focus that window and bring its
  // tab forward. The tab does NOT come here — the user asked to see the conversation, not to
  // rearrange their windows.
  ipcMain.on(IPC.conversationReveal, (e, sessionId: string, mode: TabOpenMode) => {
    if (mode !== 'preview' && mode !== 'persistent') return
    navigation.reveal(e.sender.id, sessionId, mode)
  })
  ipcMain.on(IPC.navigationReport, (e, visit: NavigationVisit | null, record: boolean, revision: number) => {
    navigation.report(e.sender.id, visit, record, revision)
  })
  ipcMain.on(IPC.navigationStep, (e, direction: number) => {
    if (direction === -1 || direction === 1) navigation.go(e.sender.id, direction)
  })
  ipcMain.on(IPC.navigationInterrupt, (e, revision: number) => navigation.intent(e.sender.id, revision))
  ipcMain.on(IPC.navigationComplete, (e, requestId: number, visit: NavigationVisit | null) => {
    navigation.complete(e.sender.id, requestId, visit)
  })
  ipcMain.on(IPC.conversationResume, (e, sessionId: string) => {
    if (hiddenSessionIds.has(sessionId)) return
    const owner = tabOwner.get(sessionId)
    if (owner == null || owner === e.sender.id) return
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.id !== owner) continue
      w.focus()
      w.webContents.send(IPC.tabResume, sessionId)
    }
  })
  // An explicit placement (Open to the Side) for a conversation another window holds. Relocating is
  // what was asked for, so that window gives the tab up; the caller opens it locally itself, and the
  // register corrects itself when both windows report their sets.
  ipcMain.on(IPC.conversationClaim, (e, sessionId: string) => {
    claimTabsForWindow(e.sender.id, [sessionId])
  })
  ipcMain.handle(IPC.tabShouldRelease, (e, sessionId: string) => {
    return shouldReleaseTab(tabOwner, e.sender.id, sessionId)
  })
  ipcMain.handle(IPC.tabReserveBound, (e, ptyId: string, oldSessionId: string, sessionId: string): string | null => {
    if (hiddenSessionIds.has(sessionId)) return null
    if (!canReserveTabForBoundPty(
      ptyOwner,
      mgr?.list() ?? [],
      e.sender.id,
      ptyId,
      sessionId
    )) return null
    const token = randomUUID()
    boundTabReservations.reserve(token, { windowId: e.sender.id, ptyId, sessionId, fromSessionId: oldSessionId })
    return token
  })
  ipcMain.on(IPC.tabCommitBound, (e, token: string) => {
    const reservation = boundTabReservations.take(token, e.sender.id)
    if (!reservation || hiddenSessionIds.has(reservation.sessionId)) return
    if (reservation.fromSessionId) {
      navigation.retarget(reservation.windowId, reservation.fromSessionId, reservation.sessionId)
    }
    claimTabsForWindow(reservation.windowId, [reservation.sessionId])
  })
  ipcMain.on(IPC.tabCancelBound, (e, token: string) => {
    boundTabReservations.take(token, e.sender.id)
  })

  // The ⌘W fallback: the renderer asks for its own window to close when it has no tab to close.
  ipcMain.on(IPC.windowClose, (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // Open one or more conversations in a new window — the same app with the rail hidden, the browser
  // one ⌘B away, rather than a second cut-down shell that would have to reimplement it. A group moved
  // here lands in ONE window holding all of them, not one window each.
  ipcMain.on(IPC.windowOpenConversation, (e, value: unknown) => {
    const parsed = parseTabDragPayload(value)
    const payload = parsed ? visibleTabDrag(parsed, hiddenSessionIds) : null
    if (!payload) return
    const opened = openWindow?.({
      ...payload,
      restoredTabs: null,
      primary: false,
      collapseRail: true
    })
    if (opened) claimTabsForWindow(opened.webContents.id, payload.sessionIds)
  })
  // Keep the OS window background in lockstep with the renderer's theme, so a live window resize
  // fills newly-exposed regions with the current --paper instead of flashing the other theme.
  ipcMain.on(IPC.windowSetBackgroundColor, (e, color: string) =>
    BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(color)
  )
  // Re-align the native macOS traffic lights to the current page zoom (the renderer pings on every
  // resize). Native buttons can't scale, but repositioning keeps them centered + proportionally
  // gapped to the wordmark — "zoom in place" (see trafficLights.ts).
  ipcMain.on(IPC.windowSyncTrafficLights, (e) =>
    syncTrafficLights(BrowserWindow.fromWebContents(e.sender))
  )
  // Swap the macOS dock icon to match the user's "dark icon" preference. The renderer pushes the
  // current choice on mount + on toggle (main can't read renderer localStorage). The light/dark PNGs
  // ship via electron-builder `extraResources` (Contents/Resources) for the packaged app; in dev
  // they're read straight from build/. No-op off macOS / when the dock is unavailable.
  ipcMain.on(IPC.windowSetDockIcon, (_e, dark: boolean) => {
    if (process.platform !== 'darwin' || !app.dock) return
    const file = dark ? 'icon-dark.png' : 'icon.png'
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, file)
      : join(app.getAppPath(), 'build', file)
    const img = nativeImage.createFromPath(iconPath)
    if (!img.isEmpty()) app.dock.setIcon(img)
  })
  // Seed the renderer's focus flag on mount; every change after that arrives via the
  // IPC.windowFocusChanged push (see windowFocus.ts — main is the sole authority).
  ipcMain.handle(
    IPC.windowIsFocused,
    (e) => {
      const focused = BrowserWindow.fromWebContents(e.sender)?.isFocused() ?? false
      if (focused) navigation.focused(e.sender.id)
      return focused
    }
  )

  // --- self-update: check compares the build commit to main via Git; run shells out to
  // `git pull --ff-only <https> main && npm run setup` in the source repo, streaming output. ---
  ipcMain.handle(IPC.updatesGetInfo, () => buildInfo())
  ipcMain.handle(IPC.updatesCheck, (_e, force: boolean) => updateChecks.check(force === true))
  ipcMain.handle(IPC.updatesCheckStateGet, () => updateChecks.state)
  ipcMain.handle(IPC.updatesRun, () => runUpdateOnce())
  ipcMain.handle(IPC.updatesRunStateGet, () => updateRunState)
  ipcMain.on(IPC.updatesRelaunch, () => relaunchForUpdate())
  powerMonitor.on('resume', onUpdateCheckWake)
  if (process.env.SWITCHBOARD_SMOKE !== '1' && process.env.SWITCHBOARD_FAKE_UPDATING !== '1') {
    updateChecks.start()
  }

  // --- live re-index on file changes (structural: new conversations, renames, other windows) ---
  watcher = new SessionWatcher({
    projectsRoot: PROJECTS_ROOT,
    onChange: () => void reindexAndBroadcast()
  })
  watcher.start()

  // --- live turn-state: recent-activity-gated periodic re-index ---
  // The watcher catches structural changes, but Codex's lazy / boundary-clustered rollout flushes
  // mean a change event often arrives only once a turn is already complete (verified empirically). So
  // re-index on a timer while a live session produced output within LIVE_INDEX_WINDOW_MS — the active
  // turn AND a short tail after it (so the turn-end marker is caught by this fast poll). The gate
  // makes a truly idle session free; the in-flight guard keeps a slow re-index from stacking.
  let ticking = false
  liveTick = setInterval(() => {
    if (ticking || !mgr) return
    const now = Date.now()
    if (!mgr.list().some((s) => now - s.lastActivity < LIVE_INDEX_WINDOW_MS)) return
    ticking = true
    void reindexAndBroadcast().finally(() => {
      ticking = false
    })
  }, LIVE_TICK_MS)
}

export function disposeIpc(): void {
  updateChecks.dispose()
  powerMonitor.off('resume', onUpdateCheckWake)
  if (liveTick) {
    clearInterval(liveTick)
    liveTick = null
  }
  watcher?.stop()
  watcher = null
  for (const pending of pendingSnapshots.values()) {
    clearTimeout(pending.timer)
    pending.resolve(null)
  }
  pendingSnapshots.clear()
  mgr?.killAll()
  mgr = null
}
