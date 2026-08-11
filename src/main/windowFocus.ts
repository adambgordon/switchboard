/**
 * Window focus, forwarded from the main process to the renderer.
 *
 * The renderer cannot be trusted to observe its own focus. `document.hasFocus()` is false for a
 * genuinely unfocused window at mount, so it can only be a seed, and a `focus` event that lands
 * between the first render and the listener attaching is lost with nothing left to re-sample it —
 * leaving the flag stuck false for the process's lifetime. Anything gated on it then never runs.
 * The window's own focus/blur is the OS-level truth, so main owns the signal and the renderer only
 * receives it.
 *
 * Deliberately imports nothing from `electron`: the window is typed structurally, which keeps this
 * module reachable from the unit tests (they run under the node tsconfig).
 */

/** The window surface this needs. Satisfied by Electron's BrowserWindow. */
export interface FocusableWindow {
  on(event: 'focus' | 'blur', listener: () => void): unknown
  isDestroyed(): boolean
}

/**
 * Forward `win`'s focus/blur to `send`. Sends nothing until the first real transition — the renderer
 * seeds its initial value over IPC (see IPC.windowIsFocused), so an eager send here would race that
 * seed rather than replace it.
 */
export function wireWindowFocus(win: FocusableWindow, send: (focused: boolean) => void): void {
  const emit =
    (focused: boolean) =>
    (): void => {
      // A window torn down between the event and its delivery has no live webContents to send on.
      if (win.isDestroyed()) return
      send(focused)
    }
  win.on('focus', emit(true))
  win.on('blur', emit(false))
}
