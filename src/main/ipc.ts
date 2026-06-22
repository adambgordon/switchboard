import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import os from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { IPC, type Transcript } from '../shared/types'
import { indexConversations } from './sessions/indexer'
import { parseTranscript } from './sessions/parser'
import { appendCustomTitle } from './sessions/rename'
import { SessionWatcher } from './sessions/watcher'
import { PtyManager } from './pty/manager'
import { syncTrafficLights } from './trafficLights'

const PROJECTS_ROOT = join(os.homedir(), '.claude', 'projects')

let watcher: SessionWatcher | null = null
let mgr: PtyManager | null = null

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
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

  // --- conversations (read-only) ---
  ipcMain.handle(IPC.sessionsList, () => indexConversations(PROJECTS_ROOT))
  ipcMain.handle(IPC.sessionsGet, async (_e, sessionId: string): Promise<Transcript | null> => {
    const fp = await resolveSessionFile(sessionId)
    if (!fp) return null
    try {
      return await parseTranscript(fp)
    } catch {
      return null
    }
  })
  // Set/clear a conversation's title (the one write path into the JSONL): append Claude Code's own
  // `custom-title` line, then re-index + broadcast IMMEDIATELY so the new title lands in the UI now
  // rather than ~600ms later when the file watcher catches the same write (which then no-ops).
  ipcMain.handle(IPC.sessionsRename, async (_e, sessionId: string, title: string): Promise<boolean> => {
    const fp = await resolveSessionFile(sessionId)
    if (!fp) return false
    try {
      await appendCustomTitle(fp, sessionId, title)
      broadcast(IPC.sessionsChanged, await indexConversations(PROJECTS_ROOT))
      return true
    } catch {
      return false
    }
  })

  // --- live sessions (explicit spawn only) ---
  ipcMain.handle(IPC.ptyResume, (_e, sessionId: string, cwd: string, title?: string) =>
    mgr!.resume(sessionId, cwd, title)
  )
  ipcMain.handle(IPC.ptyStartNew, (_e, cwd: string) => {
    // Guard a stale default folder: if it's been deleted/renamed since it was chosen in Preferences,
    // reject so the renderer can fall back to the chooser instead of node-pty throwing on a bad cwd.
    if (!existsSync(cwd)) throw new Error(`Directory no longer exists: ${cwd}`)
    return mgr!.startNew(cwd)
  })
  ipcMain.on(IPC.ptyInput, (_e, ptyId: string, data: string) => mgr!.write(ptyId, data))
  ipcMain.on(IPC.ptyResize, (_e, ptyId: string, cols: number, rows: number) =>
    mgr!.resize(ptyId, cols, rows)
  )
  ipcMain.on(IPC.ptyKill, (_e, ptyId: string) => mgr!.kill(ptyId))
  ipcMain.on(IPC.ptySetMaxLive, (_e, n: number) => mgr!.setMaxLive(n))
  ipcMain.handle(IPC.ptyActiveList, () => mgr!.list())

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

  // --- live re-index on file changes ---
  watcher = new SessionWatcher({
    projectsRoot: PROJECTS_ROOT,
    onChange: async () => {
      try {
        broadcast(IPC.sessionsChanged, await indexConversations(PROJECTS_ROOT))
      } catch {
        /* transient fs error */
      }
    }
  })
  watcher.start()
}

export function disposeIpc(): void {
  watcher?.stop()
  watcher = null
  mgr?.killAll()
  mgr = null
}
