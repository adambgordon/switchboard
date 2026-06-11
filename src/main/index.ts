import { app, BrowserWindow, nativeImage, nativeTheme, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { registerIpc, disposeIpc, openExternalUrl } from './ipc'
import { loadWindowState, saveWindowState, resolvePlacement } from './windowState'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const userDataDir = app.getPath('userData')
  const saved = loadWindowState(userDataDir)
  const placement = resolvePlacement(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    { width: 1320, height: 860 }
  )

  // Dev convenience: when launched with SWITCHBOARD_DEV_LABEL set, show that label
  // in the window title so several parallel `npm run dev` instances are
  // distinguishable in Mission Control / the Window menu / dock-hover.
  // Unset in normal and packaged use, so the title stays a plain "Switchboard".
  const devLabel = process.env.SWITCHBOARD_DEV_LABEL?.trim()
  const windowTitle = devLabel ? `Switchboard — ${devLabel}` : 'Switchboard'

  mainWindow = new BrowserWindow({
    ...placement,
    title: windowTitle,
    minWidth: 980,
    minHeight: 620,
    show: false,
    // Seed the window fill from the OS appearance (covers System mode + the hidden pre-paint
    // frame). The renderer re-syncs the exact --paper for the resolved theme via
    // IPC.windowSetBackgroundColor before the window is shown, so explicit Light/Dark land right
    // too. Values mirror tokens.css --paper (light / dark).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a17' : '#fbfbf9',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // The renderer's <title>Switchboard</title> would otherwise overwrite the label
  // once the page loads (Electron mirrors document.title onto the window). When a dev
  // label is set, own the title update so it stays sticky; harmless no-op otherwise.
  if (devLabel) {
    mainWindow.webContents.on('page-title-updated', (e) => {
      e.preventDefault()
      mainWindow?.setTitle(windowTitle)
    })
  }

  // Re-apply a saved maximized / fullscreen state on top of the restored windowed
  // bounds. macOS "zoom" (Shift+Option+green) reads as maximized, so this is what
  // makes a filled-screen window come back filled.
  if (saved?.fullScreen) mainWindow.setFullScreen(true)
  else if (saved?.maximized) mainWindow.maximize()

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // Remember size + position + maximized/fullscreen so the next launch matches.
  // getNormalBounds() is the un-maximized rectangle (the size to restore to once
  // un-maximized); the flags carry the maximized/fullscreen state on top of it.
  mainWindow.on('close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveWindowState(userDataDir, {
        ...mainWindow.getNormalBounds(),
        maximized: mainWindow.isMaximized(),
        fullScreen: mainWindow.isFullScreen()
      })
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // External links open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('preload-error', (_e, path, error) =>
    console.error('[preload-error]', path, error)
  )
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
    console.error('[did-fail-load]', code, desc)
  )

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setName('Switchboard')

app.whenReady().then(() => {
  registerIpc()
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
  createWindow()
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
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : ''
    console.log(`SMOKE ${ok ? 'PASS' : 'FAIL'} | pty:${ok} | window:${win ? 'loaded' : 'none'} | ${detail}`)
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
  disposeIpc()
})
