import { BrowserWindow } from 'electron'

/**
 * Keep the native macOS traffic lights aligned with the (zoom-scaled) custom title bar.
 *
 * The lights are OS chrome positioned in window points via `trafficLightPosition` /
 * `setWindowButtonPosition` — they do NOT move when the page zoom (⌘+/⌘−) scales the renderer.
 * So at anything other than 100% the lights fall out of vertical center and their gap to the
 * "Switchboard" wordmark drifts. We can't resize the native buttons (Slack's don't either), but we
 * can reposition them per zoom so they stay centered + proportionally gapped — "zoom in place".
 *
 * The renderer pings `syncTrafficLights` on every `resize` (which fires on every zoom change —
 * verified), and we re-read the authoritative `webContents.getZoomFactor()` here.
 */

// Resting inset at 100% zoom. macOS centers the lights at 16/16 in our 44px bar; Adam prefers them a
// hair higher & to the left, so the resting spot is 14/14 (a 2px up-left nudge), carried as the
// constants below.
const REST_X = 14
// How far ABOVE the vertical center the lights rest — the 2px of the up-nudge (the center at 100%
// is (TITLEBAR_H - BUTTON_D)/2 = 16; resting at 14 means 2px higher). Kept as a constant offset so
// the nudge stays "a tiny bit" at any zoom instead of being amplified by the factor.
const REST_NUDGE_UP = 2
// Mirror tokens.css --titlebar-h; the macOS traffic-light cluster is ~12pt tall. At zoom f the bar
// renders TITLEBAR_H*f tall while the buttons stay BUTTON_D, so center them in the scaled bar.
const TITLEBAR_H = 44
const BUTTON_D = 12

/**
 * The traffic-light inset for a given page-zoom factor (1 = 100%, 1.2 = 120%, …). x scales the
 * resting inset (the wordmark's left padding scales by the same factor, so the gap stays
 * proportional); y centers the fixed-height buttons in the scaled bar, then lifts them by the
 * constant resting nudge. Reduces to {14,14} at factor 1 — the resting position.
 */
export function trafficLightPositionFor(factor: number): { x: number; y: number } {
  return {
    x: Math.round(REST_X * factor),
    y: Math.round((TITLEBAR_H * factor - BUTTON_D) / 2 - REST_NUDGE_UP)
  }
}

// Last factor we positioned for, per window — skip redundant native calls (resize fires on window
// drags too, where the zoom is unchanged).
const lastFactor = new WeakMap<BrowserWindow, number>()
// Windows whose traffic-light sync is paused — set around the ⌘R refresh zoom-nudge so the lights
// don't wobble out and back with it (see menu.ts refreshFocused).
const suppressed = new WeakSet<BrowserWindow>()

/** Pause/resume traffic-light repositioning for a window (the refresh nudge brackets its wiggle). */
export function setTrafficLightSyncSuppressed(win: BrowserWindow, value: boolean): void {
  if (value) suppressed.add(win)
  else suppressed.delete(win)
}

/** Reposition `win`'s traffic lights for its current zoom factor (no-op if unchanged or paused). */
export function syncTrafficLights(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed() || suppressed.has(win)) return
  const factor = win.webContents.getZoomFactor()
  if (lastFactor.get(win) === factor) return
  lastFactor.set(win, factor)
  win.setWindowButtonPosition(trafficLightPositionFor(factor))
}
