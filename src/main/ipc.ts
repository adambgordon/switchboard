import { app, ipcMain, BrowserWindow, dialog, shell, nativeImage } from 'electron'
import os from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { IPC, type AgentAvailability, type AgentKind, type Transcript } from '../shared/types'
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
    // Late-bind new Codex sessions: a new Codex rollout only lands on disk at its first turn, which is
    // exactly when this re-index fires (the live session goes active). Correlate any unbound provisional
    // Codex PTY to its freshly-indexed rollout here, rather than racing a time-boxed file poll that the
    // lazy flush outruns. Binding emits `bound` + `active-changed`, so the row upgrades in place and the
    // rollout isn't also shown as a separate Recent conversation.
    if (mgr) {
      const codexCandidates = groups
        .flatMap((g) => g.conversations)
        .filter((c) => c.agent === 'codex')
        .map((c) => ({ sessionId: c.sessionId, cwd: c.cwd, firstActivityAt: c.firstActivityAt ?? null }))
      mgr.bindProvisionalCodex(codexCandidates)
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

export function registerIpc(): void {
  mgr = new PtyManager()
  mgr.on('data', (ptyId: string, data: string) => broadcast(IPC.ptyData, ptyId, data))
  mgr.on('exit', (ptyId: string, code: number | null) => broadcast(IPC.ptyExit, ptyId, code))
  mgr.on('active-changed', (states) => broadcast(IPC.ptyActiveChanged, states))
  // A provisional new-Codex PTY got its real rollout id — tell the renderer so it can re-key its
  // session-keyed state (nav / seen / view) from the placeholder to the real id.
  mgr.on('bound', (ptyId: string, oldId: string, newId: string) =>
    broadcast(IPC.ptyBound, ptyId, oldId, newId)
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
  ipcMain.handle(IPC.ptyResume, (_e, sessionId: string, cwd: string, agent: AgentKind, title?: string) =>
    mgr!.resume(sessionId, cwd, agent, title)
  )
  ipcMain.handle(IPC.ptyStartNew, (_e, cwd: string, agent: AgentKind) => {
    // Guard a stale default folder: if it's been deleted/renamed since it was chosen in Preferences,
    // reject so the renderer can fall back to the chooser instead of node-pty throwing on a bad cwd.
    if (!existsSync(cwd)) throw new Error(`Directory no longer exists: ${cwd}`)
    return mgr!.startNew(cwd, agent)
  })
  ipcMain.on(IPC.ptyInput, (_e, ptyId: string, data: string) => mgr!.write(ptyId, data))
  ipcMain.on(IPC.ptyResize, (_e, ptyId: string, cols: number, rows: number) =>
    mgr!.resize(ptyId, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, ptyId: string) => mgr!.kill(ptyId))
  ipcMain.on(IPC.ptySetMaxLive, (_e, n: number) => mgr!.setMaxLive(n))
  ipcMain.handle(IPC.ptyActiveList, () => mgr!.list())
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
