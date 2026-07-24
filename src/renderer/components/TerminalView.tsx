import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { AgentKind } from '@shared/types'
import { attachPty } from '../lib/ptyStream'
import type { ResolvedTheme } from '../lib/theme'

interface Props {
  ptyId: string
  /** The conversation this terminal hosts — needed so Option+click can mark it unread. */
  sessionId: string
  /** Which agent owns this terminal — image paste uses each TUI's native input protocol. */
  agent: AgentKind
  visible: boolean
  /** Bump counter of a focus request targeting THIS terminal, or null. Focusing happens only
   *  when this changes to a new value — never on mere visibility — so arrow-preview of a live
   *  row shows it without stealing the keyboard. */
  focusKey: number | null
  /** The resolved app theme; swapped into xterm live via term.options.theme on change. */
  theme: ResolvedTheme
  /** Option+click in the terminal — always mark the conversation unread (never toggles). */
  onMarkUnread: (id: string) => void
}

// xterm color themes, one per app theme. claude draws its own ANSI-colored TUI, so a theme sets
// the terminal's DEFAULT bg/fg, the 16-color ANSI palette claude's output maps onto (tuned warm to
// match the paper/graphite identity — muted on light, brightened for legibility on dark), the
// cobalt selection, and a transparent cursor. The cursor is transparent in BOTH themes: Switchboard
// hides its own caret and defers to Claude's reverse-video block, so xterm's hardware cursor would
// otherwise paint a redundant second caret on the same cell. The active theme is swapped live via
// `term.options.theme` when the app theme flips (see the theme effect below), so a running claude
// session recolors in place.
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: 'rgba(0,0,0,0)',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(31, 90, 230, 0.18)',
  black: '#262626',
  red: '#c8341a',
  green: '#3a7d44',
  yellow: '#9a6b00',
  blue: '#2f5fa8',
  magenta: '#8a3fa0',
  cyan: '#1f7a8c',
  white: '#6b6b6b',
  brightBlack: '#9a9a9a',
  brightRed: '#e2431d',
  brightGreen: '#4a9d57',
  brightYellow: '#b8860b',
  brightBlue: '#3f73c4',
  brightMagenta: '#a85bbf',
  brightCyan: '#2a96aa',
  brightWhite: '#1a1a1a'
}

// Neutral dark theme: bg matches the dark --paper-pane (#171717, the main content surface the terminal
// fills — kept in lockstep with tokens.css so the canvas and its surrounding pane read as one), fg is
// the dark --ink, and the ANSI palette is lifted to read on the dark surface. Neutral grays (no warm
// cast); chromatic slots stay vivid. Cobalt selection at a higher alpha for contrast.
const DARK_THEME = {
  background: '#171717',
  foreground: '#f2f2f2',
  cursor: 'rgba(0,0,0,0)',
  cursorAccent: '#171717',
  selectionBackground: 'rgba(59, 108, 240, 0.3)',
  black: '#3a3a3a',
  red: '#f0786a',
  green: '#7fb685',
  yellow: '#d3a04a',
  blue: '#6f9bff',
  magenta: '#c98bd6',
  cyan: '#5fb5c4',
  white: '#c0c0c0',
  brightBlack: '#626262',
  brightRed: '#ff8a7e',
  brightGreen: '#93c999',
  brightYellow: '#e6b860',
  brightBlue: '#84a7ff',
  brightMagenta: '#dba0e6',
  brightCyan: '#74c6d4',
  brightWhite: '#f2f2f2'
}

const THEMES = { light: LIGHT_THEME, dark: DARK_THEME }

function openExternalLink(_event: MouseEvent, uri: string): void {
  window.api.openExternal(uri)
}

// Escape a filesystem path for insertion into the prompt line the way a real
// terminal does on drag-drop: backslash-escape spaces + shell metacharacters so
// paths resolve correctly. (Native drag-drop uses this escaping and "never fails".)
function escapePath(p: string): string {
  return p.replace(/([\s'"\\$`!&;|*?<>(){}[\]#~])/g, '\\$1')
}

// Force xterm to recompute its scroll-area height from the CURRENT buffer length, so the scrollbar
// range tracks Codex's scrollback growth. Codex renders to the normal buffer with scrollback; after a
// resize/replay — or after the buffer grew while this terminal was hidden (display:none) — xterm's own
// scroll-area sync can lag, leaving the range short (at worst collapsed to a single screen). The newest
// rows then sit BELOW what the wheel/drag can reach: you can only get to the bottom via Enter or a
// resize (the reported "can't scroll to the bottom" on a live Codex session). This is Codex-only —
// claude runs on the alternate screen (no scrollback), so its range never grows. `true` recomputes
// synchronously; it re-syncs scrollTop to the CURRENT ydisp, so it never moves the view (no yank).
// `_core.viewport` is private xterm API, guarded with optional chaining like the _renderService unpause.
function syncScrollArea(term: Terminal): void {
  const vp = (
    term as unknown as { _core?: { viewport?: { syncScrollArea?: (immediate?: boolean) => void } } }
  )._core?.viewport
  vp?.syncScrollArea?.(true)
}

export default function TerminalView({ ptyId, sessionId, agent, visible, focusKey, theme, onMarkUnread }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastSentRef = useRef<{ cols: number; rows: number } | null>(null)
  // rAF handle coalescing the post-output scroll-area recompute to one call per frame (see syncScrollArea).
  const syncRafRef = useRef<number | null>(null)

  // Fit the terminal to its host and push the new size to the PTY — but ONLY when the host is
  // genuinely measurable, and only when the size actually changed. A hidden deck item
  // (display:none on the inactive conversation) reports a 0×0 host, yet FitAddon still derives a
  // bogus ~13×5 grid from the host's height/width:100% *computed* style (parseInt("100%") → 100px,
  // ÷ cell size). Pushing that to the PTY makes claude reflow its whole TUI into a tiny grid and
  // back when you switch away and return — stranding real blank rows in the buffer (the "whitespace
  // after tool calls" gap). The ResizeObserver firing on hide (size → 0) is the actual trigger, so
  // the 0×0 guard neutralizes it (and the same guard means a hidden mount no longer boots claude at
  // a bogus size). Suppressing no-op resizes keeps conversation/view switches from spamming SIGWINCH
  // for no size change.
  const fitAndResize = useCallback(() => {
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return
    if (host.clientWidth === 0 || host.clientHeight === 0) return
    try {
      fit.fit()
    } catch {
      return
    }
    const { cols, rows } = term
    const last = lastSentRef.current
    if (last && last.cols === cols && last.rows === rows) return
    lastSentRef.current = { cols, rows }
    window.api.resize(ptyId, cols, rows)
  }, [ptyId])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
      fontSize: 11.5,
      // 1.3, not a rounder value: 11.5×1.3≈15px keeps the cell height ~integer. WebGL (the
      // primary renderer) doesn't need this, but the canvas FALLBACK (loaded on GPU-context
      // loss) strands blank rows during rapid live redraws at a fractional cell — so 1.3 stays
      // for that path. It was 1.32 (15.18px) and showed whitespace gaps — don't bump back.
      lineHeight: 1.3,
      letterSpacing: 0,
      // Switchboard's own terminal cursor is hidden (transparent `theme.cursor` above): we defer
      // to Claude Code, which draws and styles its own block caret. xterm's hardware cursor would
      // otherwise render a redundant second cursor on the same cell. 'bar' (not the default
      // 'block') guards the glyph under the caret from being recolored should the color ever be
      // made visible; blink off avoids a needless (invisible) blink timer. Trade-off: no visible
      // cursor at a bare shell prompt — but this terminal exists to host a live `claude`, which
      // owns the caret. (This also subsumes the old `cursorInactiveStyle: 'none'` — a transparent
      // cursor is invisible focused or not, so arrow-preview shows no stray cursor box either.)
      cursorBlink: false,
      cursorStyle: 'bar',
      allowProposedApi: true,
      macOptionIsMeta: true,
      scrollback: 8000,
      linkHandler: { activate: openExternalLink },
      theme: THEMES[theme]
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon(openExternalLink))
    term.open(host)
    // claude renders tables / box-art using Unicode-11 (emoji-aware) cell widths,
    // where emoji like ✅/❌ occupy 2 cells. xterm defaults to the Unicode V6 width
    // table, which counts them as 1 — so on any row with an emoji the cells after it
    // (including the closing │ border) land one column off, misaligning the table
    // (and the half-cell of emoji overdraw flickers under partial canvas repaints on
    // scroll/select). Load + activate the Unicode 11 provider before the first write
    // so widths match claude from the first paint. (Needs allowProposedApi, set above.)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    // GPU (WebGL) renderer, loaded post-open as xterm requires — now the PRIMARY renderer.
    // It composites cells on the GPU (a glyph texture atlas + batched draws), far more robust
    // than the canvas addon under the rapid partial repaints a live `claude` emits — which is
    // what caused the intermittent scroll jitter and the stranded-whitespace rows (the canvas
    // text-layer repaint desync we'd only half-patched via lineHeight). WebGL also draws every
    // glyph every frame WITHOUT clipping it to its cell (canvas clips per row), so box-drawing
    // joins / tall glyphs that overflow a cell render cleanly. `customGlyphs` (default true) is
    // honored here too, so claude's table/box borders stay continuous vector lines as before.
    // xterm.js and VS Code are both consolidating onto WebGL and phasing the canvas addon out,
    // so this is the forward path, not a stopgap.
    //
    // Fallback: on GPU-context loss — a driver reset, or Chromium evicting the least-recently-
    // used context past its ~16-per-page ceiling — swap to the CANVAS addon (NOT xterm's
    // built-in DOM renderer, which pulls box-drawing from the font and breaks claude's borders
    // at our fractional cell). So onContextLoss is both routine recovery and the >16-context
    // failsafe. If WebGL can't initialize at all (it always can under our Electron/Chromium —
    // belt and suspenders), fall straight back to canvas.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        try {
          term.loadAddon(new CanvasAddon())
        } catch {
          /* last resort: xterm's built-in DOM renderer */
        }
      })
      term.loadAddon(webgl)
    } catch {
      term.loadAddon(new CanvasAddon())
    }

    termRef.current = term
    fitRef.current = fit

    // Size the terminal to its container BEFORE the PTY backlog floods in. On resume the host is
    // already visible (display:block) and measurable, so this synchronous fit resizes the still-
    // empty renderer once, up front — instead of letting claude's replay flood paint at the
    // default 80×24 and then paying a ~170ms WebGL resize mid-flood (the trace's single worst
    // main-thread task on resume, ~950ms in). The rAF + ResizeObserver below stay as the fallback
    // for when the host isn't measurable yet (created while hidden) and for later/window resizes.
    fitAndResize()

    // After Codex output, recompute the scrollbar range so the newest rows stay reachable (see
    // syncScrollArea) — coalesced to one call per frame regardless of how many chunks arrived. Claude
    // is alternate-screen (no scrollback), so it keeps the plain write with zero added per-output work.
    const detach =
      agent === 'codex'
        ? attachPty(ptyId, (d) =>
            term.write(d, () => {
              if (syncRafRef.current != null) return
              syncRafRef.current = requestAnimationFrame(() => {
                syncRafRef.current = null
                const t = termRef.current
                if (t) syncScrollArea(t)
              })
            })
          )
        : attachPty(ptyId, (d) => term.write(d))
    const onInput = term.onData((d) => window.api.sendInput(ptyId, d))

    // Image input is agent-specific. Claude reads the clipboard after an empty bracketed paste;
    // Codex reserves the real Ctrl+V key and reads the clipboard from that key event.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyV') {
        window.api.sendInput(ptyId, agent === 'codex' ? '\x16' : '\x1b[200~\x1b[201~')
        return false
      }
      return true
    })

    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      const paths = files.map((f) => escapePath(window.api.getPathForFile(f))).join(' ')
      // Both agents recognize an image path delivered as a paste and attach it to the prompt.
      window.api.sendInput(ptyId, `\x1b[200~${paths}\x1b[201~`)
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)

    // Cmd+V is text-only. macOS fires a DOM 'paste' event for Cmd+V (but not for
    // Ctrl+V), separate from the keydown above. If the clipboard carries no text
    // (e.g. a screenshot), block the event in capture — before xterm's own paste
    // handler runs — so image attachment stays exclusively on Ctrl+V.
    // Text pastes fall through to xterm untouched, so multi-line paste still works.
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    host.addEventListener('paste', onPaste, true)

    const offExit = window.api.onPtyExit((id, code) => {
      if (id === ptyId) {
        term.write(`\r\n\x1b[2m—— session ended (exit ${code ?? 0}) ——\x1b[0m\r\n`)
      }
    })

    // Initial fit already ran synchronously above (before the flood). These stay as the fallback
    // path (host not yet measurable at mount) and for genuine later resizes (window / pane).
    const raf = requestAnimationFrame(fitAndResize)
    const ro = new ResizeObserver(fitAndResize)
    ro.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      if (syncRafRef.current != null) cancelAnimationFrame(syncRafRef.current)
      syncRafRef.current = null
      ro.disconnect()
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      host.removeEventListener('paste', onPaste, true)
      offExit()
      onInput.dispose()
      detach()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      lastSentRef.current = null
    }
  }, [ptyId, agent, fitAndResize])

  // Re-skin the terminal when the app theme flips. xterm applies term.options.theme live (re-reads
  // the palette and repaints), so a running claude session recolors in place — no remount. The
  // construction effect captures the initial theme; this owns every subsequent change.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = THEMES[theme]
  }, [theme])

  // Option+click anywhere in the terminal marks this conversation unread (the in-terminal twin of
  // the left-pane row gesture). Capture phase + stopPropagation is load-bearing on BOTH sides: it
  // fires before MainPane's bubble-phase engage listener (which would call markRead on the same
  // click and self-clear the mark), and it stops the event before xterm's own descendant handlers
  // (alt-click cursor-move / selection / mouse-report forwarding) — so the mark sticks and nothing
  // else acts on the click. `manualUnread` deliberately beats "looking" in resolveLiveState, so the
  // dot goes solid even though this conversation is open+focused. mousedown-only (never the
  // high-frequency mousemove), and its OWN effect with stable deps so it never re-runs the
  // expensive xterm/WebGL construction effect above.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onDown = (e: MouseEvent): void => {
      if (e.altKey && e.button === 0) {
        e.preventDefault()
        e.stopPropagation()
        onMarkUnread(sessionId)
      }
    }
    host.addEventListener('mousedown', onDown, true)
    return () => host.removeEventListener('mousedown', onDown, true)
  }, [sessionId, onMarkUnread])

  // Refit when this terminal becomes the visible one (it may have been sized to 0 while hidden
  // behind display:none), then WAKE its renderer and force a repaint. xterm pauses a terminal's
  // renderer while its screen element is off-screen: an IntersectionObserver in xterm's
  // RenderService flips `_isPaused` true when the element isn't intersecting (which display:none
  // triggers), and `refreshRows` / `handleResize` then *drop* (or queue) every request. The renderer
  // only un-pauses when the observer fires `isIntersecting` again — but Chromium does NOT reliably
  // deliver that on a pure display:none→block toggle (it recomputes intersection on scroll/layout),
  // so the terminal can sit frozen on its last painted frame — e.g. claude's mid-thought spinner —
  // until a manual scroll nudges the observer. A blind term.refresh() here is therefore dropped
  // whenever the observer hasn't fired yet (the old two-rAF approach only worked when it happened to
  // fire within ~2 frames). So we clear `_isPaused` ourselves — before the fit, so the fit's
  // handleResize runs now instead of being queued — then refresh, guaranteeing the repaint. The
  // observer later sets `_isPaused` correctly (visible ⇒ false), a no-op. Reaching into
  // `_core._renderService` is private xterm API, guarded with optional chaining so a future rename
  // degrades to the old observer-dependent behavior rather than throwing. One-time on navigation —
  // no per-frame cost. Focus is handled separately (below) so that merely becoming visible — e.g.
  // via arrow-preview or back/forward — does NOT grab the keyboard.
  useEffect(() => {
    if (!visible) return
    // Clear xterm's IntersectionObserver "paused" flag so refreshes/resizes paint instead of being
    // dropped while the observer hasn't yet registered the show. See the note above.
    const unpause = (): void => {
      const rs = (
        termRef.current as unknown as {
          _core?: { _renderService?: { _isPaused?: boolean } }
        } | null
      )?._core?._renderService
      if (rs && rs._isPaused) rs._isPaused = false
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      const term = termRef.current
      if (!term) return
      unpause()
      fitAndResize()
      term.refresh(0, term.rows - 1)
      // The buffer may have grown while this terminal was hidden; recompute the scrollbar range now
      // that it's visible + sized so the newest rows are reachable (Codex scrollback only).
      if (agent === 'codex') syncScrollArea(term)
      raf2 = requestAnimationFrame(() => {
        const t = termRef.current
        if (!t) return
        unpause()
        t.refresh(0, t.rows - 1)
        if (agent === 'codex') syncScrollArea(t)
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [visible, ptyId, agent, fitAndResize])

  // Focus only on an explicit, session-targeted request (click / Enter / resume / new /
  // go-live), tracked by a bump counter so re-focusing the same terminal still fires. A change
  // in visibility alone never focuses; `appliedFocusRef` guards against re-focusing when this
  // terminal re-shows (e.g. arrow back onto it) with an unchanged focusKey.
  const appliedFocusRef = useRef<number | null>(null)
  useEffect(() => {
    if (focusKey == null || !visible) return
    if (focusKey === appliedFocusRef.current) return
    appliedFocusRef.current = focusKey
    const id = requestAnimationFrame(() => termRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [focusKey, visible, ptyId])

  return <div className="sb-term" ref={hostRef} />
}
