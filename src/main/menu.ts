import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'
import { setTrafficLightSyncSuppressed } from './trafficLights'

// How far to nudge the page zoom for a refresh, in zoom *levels* (Electron's 1.2^level scale).
// A FULL level (1.0 ≈ 20%) is jarring; this is gentler (≈9%) while staying large enough to cross
// a terminal cell-row boundary at any window size down to the app minimum — which is what makes
// the nudge emit a real SIGWINCH (too small a nudge rounds to the same cols/rows ⇒ no redraw).
// Tunable: lower it for less flicker (at the risk of not crossing a boundary on a short window).
const REFRESH_ZOOM_NUDGE = 0.5

/**
 * Refresh the focused window's terminals by momentarily nudging the page zoom and restoring it —
 * the same thing a manual ⌘+ / ⌘− does. Changing the zoom relayouts the whole renderer, which
 * (a) fires each terminal host's ResizeObserver → fitAndResize → a real PTY resize (SIGWINCH) →
 * claude repaints its entire screen, and (b) forces a full-page recomposite, which clears a stale
 * WebGL frame (a bare terminal redraw can't do the latter — see the repo CLAUDE.md "stale
 * composite" note). The nudge is kept small (REFRESH_ZOOM_NUDGE) so the flicker is minimal.
 *
 * This is what ⌘R is bound to INSTEAD of `reload`. A renderer reload would destroy every xterm
 * buffer — the main process keeps no PTY output to replay (PtyManager only streams live bytes), so
 * the freshly-mounted terminals attach to an empty backlog and an idle claude emits nothing →
 * every live terminal goes blank, recoverable only by a real dimension change (which is why a
 * manual zoom "fixed" it). Repurposing ⌘R gives the "reload to fix rendering" instinct an action
 * that actually fixes rendering, with none of the destruction.
 */
function refreshFocused(): void {
  const win = BrowserWindow.getFocusedWindow()
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  const z = wc.getZoomLevel()
  // Nudge DOWN by default (smaller cells = more rows/cols, and a touch less jarring than zooming
  // in); nudge up only when we're already near the practical floor, so it's never clamped to a
  // no-op.
  const delta = z <= -3 ? REFRESH_ZOOM_NUDGE : -REFRESH_ZOOM_NUDGE
  // The nudge changes the zoom, which the renderer reports so the traffic lights re-align (see
  // trafficLights.ts) — but here it's transient and restored below, so suppress that sync across
  // the wiggle. The restored zoom equals the original, so on un-suppress the lights are already
  // where they belong; this just prevents a brief out-and-back jump of the buttons on every ⌘R.
  setTrafficLightSyncSuppressed(win, true)
  wc.setZoomLevel(z + delta)
  // Restore a few frames later: the ResizeObserver coalesces within a frame, so an out-and-back in
  // one tick nets to no size change (and no SIGWINCH). ~60ms lets the intermediate layout land,
  // then we return to the user's exact zoom.
  setTimeout(() => {
    if (!win.isDestroyed()) wc.setZoomLevel(z)
    setTrafficLightSyncSuppressed(win, false)
  }, 60)
}

/**
 * Install a minimal custom application menu.
 *
 * The app otherwise ships Electron's default menu, whose View submenu hands out Reload (⌘R) /
 * Force Reload (⇧⌘R) — destructive here (see refreshFocused). We rebuild from role-based submenus
 * so every standard menu and shortcut is preserved (App, File, Edit, Window, plus copy/paste,
 * quit, close, zoom), and replace ONLY View: ⌘R → "Refresh", with the reload roles removed.
 * macOS-only, matching the app.
 */
export function installAppMenu(): void {
  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        label: 'Refresh',
        accelerator: 'CmdOrCtrl+R',
        click: () => refreshFocused()
      },
      {
        // ⇧⌘R (the old Force Reload chord) → the same refresh, so any "reload" instinct lands on a
        // safe refresh. Hidden — the ⌘R item already represents the action — but its accelerator
        // still fires (acceleratorWorksWhenHidden, default true on macOS, set explicitly here to
        // document intent).
        label: 'Refresh (Force)',
        accelerator: 'CmdOrCtrl+Shift+R',
        acceleratorWorksWhenHidden: true,
        visible: false,
        click: () => refreshFocused()
      },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { role: 'togglefullscreen' }
    ]
  }

  // File: the default macOS File menu (the `fileMenu` role) is just "Close Window"; we also
  // surface Quit here. Quit already lives in the app menu by macOS convention, but it's wanted in
  // File too — both items share the ⌘Q accelerator, which is harmless since both simply quit.
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [{ role: 'close' }, { type: 'separator' }, { role: 'quit' }]
  }

  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    file,
    { role: 'editMenu' },
    view,
    { role: 'windowMenu' }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
