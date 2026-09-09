import { app, BrowserWindow, nativeImage, nativeTheme, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  registerIpc,
  disposeIpc,
  openExternalUrl,
  prepareWindowClose,
  releaseWindow,
  setWindowOpener,
  initializeTabWorkspace,
  registerTabWindow,
  flushTabWorkspace,
  navigationWindowFocused
} from './ipc'
import { installAppMenu } from './menu'
import { loadWindowState, saveWindowState, resolvePlacement } from './windowState'
import { trafficLightPositionFor } from './trafficLights'
import { wireWindowFocus } from './windowFocus'
import { IPC, type WindowInit } from '../shared/types'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The FIRST window. Not "the only window" — a conversation can be opened in its own window, and any
 * number may be open. This reference exists for the things that are genuinely singular: persisted
 * bounds (the first window's geometry is what a fresh launch restores) and the smoke check's report.
 * Everything per-window — focus forwarding, traffic lights, the refresh veil — is keyed off the
 * window or its webContents instead.
 */
let firstWindow: BrowserWindow | null = null
let appQuitting = false

/** How far each additional window is offset from the last, so a new one never lands exactly on top. */
const CASCADE_STEP = 28

function createWindow(init?: WindowInit): BrowserWindow {
  const userDataDir = app.getPath('userData')
  const isFirst = BrowserWindow.getAllWindows().length === 0
  const windowInit: WindowInit = init ?? {
    sessionIds: [],
    activeSessionId: null,
    restoredTabs: null,
    primary: isFirst,
    collapseRail: !isFirst
  }
  const saved = loadWindowState(userDataDir)
  const placement = resolvePlacement(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    { width: 1320, height: 860 }
  )
  // Additional windows cascade off the frontmost one rather than stacking exactly on the saved
  // bounds, which would hide the fact that a second window opened at all.
  if (!isFirst) {
    const front = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1)
    const base = front && !front.isDestroyed() ? front.getNormalBounds() : placement
    placement.x = (base.x ?? 0) + CASCADE_STEP
    placement.y = (base.y ?? 0) + CASCADE_STEP
    // A detached window is a working surface for one conversation, so it opens a little tighter than
    // the full browser. Still resizable, and still above the app minimum.
    placement.width = Math.min(placement.width, 1080)
    placement.height = Math.min(placement.height, 780)
  }

  // Dev convenience: when launched with SWITCHBOARD_DEV_LABEL set, show that label
  // in the window title so several parallel `npm run dev` instances are
  // distinguishable in Mission Control / the Window menu / dock-hover.
  // Unset in normal and packaged use, so the title stays a plain "Switchboard".
  const devLabel = process.env.SWITCHBOARD_DEV_LABEL?.trim()
  const windowTitle = devLabel ? `Switchboard — ${devLabel}` : 'Switchboard'

  const win = new BrowserWindow({
    ...placement,
    title: windowTitle,
    minWidth: 980,
    minHeight: 620,
    show: false,
    // Seed the window fill from the OS appearance (covers System mode + the hidden pre-paint
    // frame). The renderer re-syncs the exact --paper for the resolved theme via
    // IPC.windowSetBackgroundColor before the window is shown, so explicit Light/Dark land right
    // too. Values mirror tokens.css --paper (light / dark).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#fbfbf9',
    titleBarStyle: 'hiddenInset',
    // Resting inset at 100% zoom; re-aligned per zoom via syncTrafficLights (trafficLights.ts).
    trafficLightPosition: trafficLightPositionFor(1),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // What this window should show, handed to the preload as a process argument rather than over
      // IPC. It has to be SYNCHRONOUS: a detached window opens with the rail hidden, and an async
      // answer would render the browser for a frame and then snap it shut.
      additionalArguments: [`--sb-window=${JSON.stringify(windowInit)}`]
    }
  })

  // The renderer's <title>Switchboard</title> would otherwise overwrite the label
  // once the page loads (Electron mirrors document.title onto the window). When a dev
  // label is set, own the title update so it stays sticky; harmless no-op otherwise.
  if (devLabel) {
    win.webContents.on('page-title-updated', (e) => {
      e.preventDefault()
      win.setTitle(windowTitle)
    })
  }

  if (isFirst) {
    firstWindow = win
    // Re-apply a saved maximized / fullscreen state on top of the restored windowed
    // bounds. macOS "zoom" (Shift+Option+green) reads as maximized, so this is what
    // makes a filled-screen window come back filled. Only the first window: a detached one is
    // deliberately a modest cascade, not a restoration of somebody else's geometry.
    if (saved?.fullScreen) win.setFullScreen(true)
    else if (saved?.maximized) win.maximize()
  }

  win.on('ready-to-show', () => win.show())
  // The renderer's focus flag comes from here and nowhere else — see windowFocus.ts for why it
  // cannot observe its own focus. Wired per window, and before it is shown, so the show()-triggered
  // focus is forwarded rather than missed.
  wireWindowFocus(win, (focused) => {
    if (focused) navigationWindowFocused(win.webContents.id)
    if (!win.isDestroyed()) win.webContents.send(IPC.windowFocusChanged, focused)
  })
  // Remember size + position + maximized/fullscreen so the next launch matches.
  // getNormalBounds() is the un-maximized rectangle (the size to restore to once
  // un-maximized); the flags carry the maximized/fullscreen state on top of it.
  //
  // ONLY the first window persists. A detached window is a temporary working surface, and letting it
  // write here would mean the next launch restored whatever size the last-closed satellite happened
  // to have rather than the browser the user actually arranged.
  const wcId = win.webContents.id
  registerTabWindow(wcId, windowInit.restoredTabs)
  let closePrepared = false
  win.on('close', (event) => {
    if (win === firstWindow && !win.isDestroyed()) {
      saveWindowState(userDataDir, {
        ...win.getNormalBounds(),
        maximized: win.isMaximized(),
        fullScreen: win.isFullScreen()
      })
    }
    if (appQuitting || closePrepared || BrowserWindow.getAllWindows().length < 2) return
    event.preventDefault()
    // Catch rather than `void` a floating promise: Node throws on an unhandled rejection, so a
    // failure in here would take the app down mid-quit. The window must close either way — the
    // preparation is a courtesy (handing owned terminals to a surviving window), not a gate.
    prepareWindowClose(wcId)
      .catch(() => {})
      .finally(() => {
        closePrepared = true
        if (!win.isDestroyed()) win.close()
      })
  })
  win.on('closed', () => {
    releaseWindow(wcId, appQuitting)
    // The original window saved its geometry on close. Do not promote a cascaded satellite and let
    // its later close overwrite that browser geometry.
    if (firstWindow === win) firstWindow = null
  })

  // External links open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  win.webContents.on('preload-error', (_e, path, error) =>
    console.error('[preload-error]', path, error)
  )
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    console.error('[did-fail-load]', code, desc)
  )

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.setName('Switchboard')

app.whenReady().then(() => {
  registerIpc()
  // Replace Electron's default menu with our own: it drops the destructive Reload / Force Reload
  // (a renderer reload blanks every live terminal — see menu.ts) and binds ⌘R to a "Refresh"
  // (zoom-wiggle repaint) instead. Role-based submenus keep every standard menu/shortcut
  // (App / File / Edit / Window, copy/paste, quit, zoom).
  installAppMenu()
  // Dev convenience: the packaged .app gets its dock icon from the bundle, but an
  // unpackaged `npm run dev` shows Electron's default. Point the dock at our PNG so
  // both match. No-op if the icon hasn't been generated yet.
  const dock = process.platform === 'darwin' ? app.dock : undefined
  if (dock && !app.isPackaged) {
    try {
      const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'))
      if (!icon.isEmpty()) dock.setIcon(icon)
    } catch {
      /* dev-only nicety — harmless if the file is missing */
    }
  }
  // Hand the IPC layer the ability to open a window, so "Open in New Window" doesn't need to reach
  // back into this module (which owns geometry, cascade, and first-window bookkeeping).
  setWindowOpener(createWindow)
  const devWorkspace = process.env.SWITCHBOARD_DEV_LABEL?.trim().replace(/[^a-z0-9._-]+/gi, '-') || 'default'
  const workspaceFile = app.isPackaged ? undefined : `tab-workspace-dev-${devWorkspace}.json`
  const savedLayout = initializeTabWorkspace(app.getPath('userData'), workspaceFile)
  const restoredTabs = process.env.SWITCHBOARD_SMOKE ? null : savedLayout
  createWindow({
    sessionIds: [],
    activeSessionId: null,
    restoredTabs,
    primary: true,
    collapseRail: false
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  if (process.env.SWITCHBOARD_SMOKE) runSmoke()
})

/**
 * Boot self-test (only when SWITCHBOARD_SMOKE=1): confirms node-pty loads and
 * spawns under Electron's ABI and the window resolved, then exits.
 */
function runSmoke(): void {
  const finish = (ok: boolean, detail: string): void => {
    const win = firstWindow && !firstWindow.isDestroyed() ? firstWindow.webContents.getURL() : ''
    console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'} | pty:${ok} | window:${win ? 'loaded' : 'none'} | ${detail}`)
    // app.exit() intentionally skips before-quit, so release IPC-owned watchers explicitly.
    disposeIpc()
    app.exit(ok ? 0 : 1)
  }
  const sh = process.env.SHELL || '/bin/zsh'
  import('node-pty')
    .then((pty) => {
      let out = ''
      const p = pty.spawn(sh, ['-lc', 'echo SMOKE_PTY_OK'], {
        name: 'xterm-color',
        cols: 80,
        rows: 20,
        cwd: process.env.HOME || '.'
      })
      const timer = setTimeout(() => finish(false, 'pty timeout'), 8000)
      p.onData((d) => (out += d))
      p.onExit(() => {
        clearTimeout(timer)
        finish(out.includes('SMOKE_PTY_OK'), `out=${JSON.stringify(out.trim().slice(-40))}`)
      })
    })
    .catch((e) => finish(false, `node-pty load failed: ${String(e)}`))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appQuitting = true
  flushTabWorkspace()
  disposeIpc()
})
