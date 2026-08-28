import {
  app,
  clipboard,
  ipcMain,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  nativeImage,
  screen,
  type MenuItemConstructorOptions
} from 'electron'
import os from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import {
  IPC,
  type AgentAvailability,
  type AgentKind,
  type PtyBindKind,
  type PtySession,
  type PtyState,
  type TabDropOutcome,
  type TabMenuAction,
  type Transcript,
  type WindowInit
} from '../shared/types'
import { indexConversations, type MetaCache } from './sessions/indexer'
import { parseTranscript } from './sessions/parser'
import { parseCodexTranscript, resolveCodexFile } from './sessions/codexParser'
import { appendCustomTitle } from './sessions/rename'
import { renameCodexThread } from './sessions/codexRename'
import { SessionWatcher } from './sessions/watcher'
import { PtyManager } from './pty/manager'
import { syncTrafficLights } from './trafficLights'
import { buildInfo, checkForUpdates, runUpdate, relaunchForUpdate } from './updater'

const PROJECTS_ROOT = join(os.homedir(), '.claude', 'projects')

let watcher: SessionWatcher | null = null
let mgr: PtyManager | null = null
let liveTick: ReturnType<typeof setInterval> | null = null

// --- the window layer ---------------------------------------------------------------------------
//
// `PtyManager` owns terminal lifecycle and knows nothing about windows; it streams bytes to every
// renderer. Everything below is the part that only this module can know, because the spawning window
// is the IPC sender.

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
let openWindow: ((init?: WindowInit) => void) | null = null

export function setWindowOpener(fn: (init?: WindowInit) => void): void {
  openWindow = fn
}

/**
 * The tab drag currently in flight, if any — main's whole share of cross-window dragging.
 *
 * `hoveringId` is which window is currently showing the "you can drop here" state, so it can be told
 * to stop when the cursor moves on. Held here rather than in either renderer because neither can see
 * the other: the OS gives the source window mouse capture for the duration.
 */
let tabDrag: { sourceId: number; sessionId: string; hoveringId: number | null } | null = null

function sendToWindow(wcId: number | null, channel: string, ...args: unknown[]): void {
  if (wcId == null) return
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.id === wcId && !w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

function endTabDrag(): void {
  if (!tabDrag) return
  sendToWindow(tabDrag.hoveringId, IPC.tabDragLeave)
  tabDrag = null
}

/**
 * The topmost visible window containing the cursor, or null when the cursor is over none.
 *
 * Deliberately asked of the OS rather than taken from the pointer event: `MouseEvent.screenX/screenY`
 * is in the renderer's CSS pixels, and this app zooms (⌘+/-), so those coordinates and a window's DIP
 * bounds part company at any zoom but 100%. `getCursorScreenPoint` is in the same space as the bounds.
 *
 * `getAllWindows` returns front-to-back, so the first hit is the topmost — which is the one the user
 * sees under the cursor, and therefore the one they mean.
 */
function windowUnderCursor(): BrowserWindow | null {
  const { x, y } = screen.getCursorScreenPoint()
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.isVisible() || w.isMinimized()) continue
    const b = w.getBounds()
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) return w
  }
  return null
}

/**
 * A window closed. Its claims are released so a surviving window can take those terminals over —
 * without this a live session whose window was closed would stay unreachable for the rest of the run,
 * still running, with no window permitted to show it.
 */
export function releaseWindow(webContentsId: number): void {
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
  if (released) emitActive()
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

/** Re-index both agents' sessions and push the result to the renderer. Swallows transient fs errors. */
async function reindexAndBroadcast(): Promise<void> {
  try {
    const groups = await indexConversations(PROJECTS_ROOT, undefined, metaCache)
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
    const sig = JSON.stringify(groups)
    if (sig === lastBroadcastSig) return
    lastBroadcastSig = sig
    broadcast(IPC.sessionsChanged, groups)
  } catch {
    /* transient fs error */
  }
}

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
    execFile(shell, ['-lic', 'command -v claude; command -v codex'], { timeout: 4000 }, (_err, stdout) => {
      const lines = (typeof stdout === 'string' ? stdout : '').split('\n').map((l) => l.trim())
      const has = (name: string): boolean => lines.some((l) => l === name || l.endsWith('/' + name))
      resolve({ claude: has('claude'), codex: has('codex') })
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
  opts: { closeOthers: boolean; details: boolean; splitRight: boolean; newWindow: boolean },
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
    const items: MenuItemConstructorOptions[] = [{ label: 'Close Tab', click: pick('close') }]
    if (opts.closeOthers) items.push({ label: 'Close Other Tabs', click: pick('closeOthers') })
    // Where a tab can be sent. Both are hidden rather than disabled when they do not apply, matching
    // `details` and the row menu: a control that silently does nothing is worse than an absent one.
    // "Split Right" covers both creating the split and adding to an existing one — the renderer
    // decides which, since only it knows the layout, and only offers the item when the result differs
    // from where the tab already is.
    if (opts.splitRight || opts.newWindow) {
      items.push({ type: 'separator' })
      if (opts.splitRight) items.push({ label: 'Split Right', click: pick('splitRight') })
      if (opts.newWindow) {
        items.push({ label: 'Open in New Window', click: pick('newWindow') })
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
  mgr.on('data', (ptyId: string, data: string) => broadcast(IPC.ptyData, ptyId, data))
  mgr.on('exit', (ptyId: string, code: number | null) => broadcast(IPC.ptyExit, ptyId, code))
  mgr.on('active-changed', () => emitActive())
  // A Codex PTY's sessionId changed. `kind` must be forwarded: it tells the renderer whether this
  // replaced a placeholder (everything keyed to it migrates) or corrected a terminal onto a different
  // real conversation (CONVERSATION-owned state — persisted seen/unread, earlier history stops —
  // stays put, while terminal-owned state — selection, current stop, surface, Live slot — follows the
  // terminal). See PtyBindKind.
  mgr.on('bound', (ptyId: string, oldId: string, newId: string, kind: PtyBindKind) =>
    broadcast(IPC.ptyBound, ptyId, oldId, newId, kind)
  )

  // Warm the agent-availability probe now so the first New-menu open is instant (it's cached).
  void listAgents()

  // --- conversations (read-only) ---
  ipcMain.handle(IPC.sessionsList, () => indexConversations(PROJECTS_ROOT, undefined, metaCache))
  ipcMain.handle(IPC.sessionsGet, async (_e, sessionId: string): Promise<Transcript | null> => {
    // Claude first (its filename stem IS the id); fall back to a Codex rollout (trailing UUID).
    const claudeFp = await resolveSessionFile(sessionId)
    if (claudeFp) {
      try {
        return await parseTranscript(claudeFp)
      } catch {
        return null
      }
    }
    const codexFp = await resolveCodexFile(sessionId)
    if (codexFp) {
      try {
        return await parseCodexTranscript(codexFp)
      } catch {
        return null
      }
    }
    return null
  })
  // Set/clear a conversation's title, then re-index + broadcast IMMEDIATELY so the new title lands in
  // the UI now rather than when the watcher/poll next fires. Dispatch by agent: a Claude session has a
  // JSONL file (we append its own `custom-title` line); otherwise it's Codex — the sessionId IS the
  // app-server threadId, and the rename writes Codex's own DB (`threads.title`), which the re-index's
  // title read then surfaces (the rollout is untouched).
  ipcMain.handle(IPC.sessionsRename, async (_e, sessionId: string, title: string): Promise<boolean> => {
    const claudeFp = await resolveSessionFile(sessionId)
    try {
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
  ipcMain.handle(IPC.ptyResume, (e, sessionId: string, cwd: string, agent: AgentKind, title?: string) => {
    const st = mgr!.resume(sessionId, cwd, agent, title)
    ptyOwner.set(st.ptyId, e.sender.id)
    emitActive()
    return forWindow([st], e.sender.id)[0]
  })
  ipcMain.handle(IPC.ptyStartNew, (e, cwd: string, agent: AgentKind) => {
    // Guard a stale default folder: if it's been deleted/renamed since it was chosen in Preferences,
    // reject so the renderer can fall back to the chooser instead of node-pty throwing on a bad cwd.
    if (!existsSync(cwd)) throw new Error(`Directory no longer exists: ${cwd}`)
    const st = mgr!.startNew(cwd, agent)
    ptyOwner.set(st.ptyId, e.sender.id)
    emitActive()
    return forWindow([st], e.sender.id)[0]
  })
  // Take a terminal over from another window. The previous owner's xterm unmounts and ours mounts;
  // the fresh xterm starts empty, and its first fit pushes this window's geometry, which is what makes
  // the agent repaint into it.
  ipcMain.on(IPC.ptyClaim, (e, ptyId: string) => {
    if (!mgr?.list().some((s) => s.ptyId === ptyId)) return
    if (ptyOwner.get(ptyId) === e.sender.id) return
    ptyOwner.set(ptyId, e.sender.id)
    emitActive()
  })
  ipcMain.on(IPC.ptyInput, (_e, ptyId: string, data: string) => mgr!.write(ptyId, data))
  ipcMain.on(IPC.ptyResize, (_e, ptyId: string, cols: number, rows: number) =>
    mgr!.resize(ptyId, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, ptyId: string) => mgr!.kill(ptyId))
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
      opts: { closeOthers: boolean; details: boolean; splitRight: boolean; newWindow: boolean }
    ) => popTabContextMenu(opts, BrowserWindow.fromWebContents(e.sender))
  )
  // ---- dragging a tab between windows ----
  // The referee. While a mouse button is held the OS delivers every move to the window the drag began
  // in, so no other window can see the pointer over itself; main is the only party that can. It reads
  // the cursor ON DEMAND — never on a timer — and only between dragBegin and drop/cancel.
  ipcMain.on(IPC.tabDragBegin, (e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    tabDrag = { sourceId: e.sender.id, sessionId, hoveringId: null }
  })
  ipcMain.on(IPC.tabDragHover, () => {
    if (!tabDrag) return
    const target = windowUnderCursor()
    // Only the window under the cursor is highlighted, and only when it is not the source — the
    // source shows its own caret locally, from real pointer events it is already receiving.
    const id = target && target.webContents.id !== tabDrag.sourceId ? target.webContents.id : null
    if (id === tabDrag.hoveringId) return
    sendToWindow(tabDrag.hoveringId, IPC.tabDragLeave)
    tabDrag.hoveringId = id
    sendToWindow(id, IPC.tabDragOver)
  })
  ipcMain.handle(IPC.tabDragDrop, (e): TabDropOutcome => {
    const drag = tabDrag
    endTabDrag()
    if (!drag || drag.sourceId !== e.sender.id) return 'cancelled'
    const target = windowUnderCursor()
    if (target && target.webContents.id !== drag.sourceId) {
      target.webContents.send(IPC.tabDropHere, drag.sessionId)
      target.focus()
      return 'moved'
    }
    // Still over the source window, just not over a strip — dropping a tab back onto its own window
    // means nothing, so it means nothing.
    if (target) return 'cancelled'
    // Over no window at all: released on the desktop, which is the detach gesture.
    openWindow?.({ sessionId: drag.sessionId, collapseRail: true })
    return 'detached'
  })
  ipcMain.on(IPC.tabDragCancel, () => endTabDrag())

  // The ⌘W fallback: the renderer asks for its own window to close when it has no tab to close.
  ipcMain.on(IPC.windowClose, (e) => BrowserWindow.fromWebContents(e.sender)?.close())
  // Open a conversation in its own window. The new window is the same app with the rail hidden — the
  // browser is one ⌘B away — rather than a second, cut-down shell that would have to reimplement it.
  ipcMain.on(IPC.windowOpenConversation, (_e, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return
    openWindow?.({ sessionId, collapseRail: true })
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
    (e) => BrowserWindow.fromWebContents(e.sender)?.isFocused() ?? false
  )

  // --- self-update: check compares the build commit to main (GitHub API, HTTPS); run shells out to
  // `git pull --ff-only <https> main && npm run setup` in the source repo, streaming output. ---
  ipcMain.handle(IPC.updatesGetInfo, () => buildInfo())
  ipcMain.handle(IPC.updatesCheck, () => checkForUpdates())
  ipcMain.handle(IPC.updatesRun, (e) => runUpdate((line) => e.sender.send(IPC.updatesProgress, line)))
  ipcMain.on(IPC.updatesRelaunch, () => relaunchForUpdate())

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
  if (liveTick) {
    clearInterval(liveTick)
    liveTick = null
  }
  watcher?.stop()
  watcher = null
  mgr?.killAll()
  mgr = null
}
