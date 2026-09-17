import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { AgentKind, PtySnapshot } from '@shared/types'
import { HANDOFF_SCROLLBACK_ROWS } from '@shared/terminalHistory'
import { attachPty, pendingPtySnapshot } from '../lib/ptyStream'
import type { ResolvedTheme } from '../lib/theme'
import { installScrollbackSafeScrollUp } from '../lib/xtermScrollUp'

interface Props {
  /** Pane-owned portal target. Changing it moves the existing xterm DOM without recreating xterm. */
  mountNode: HTMLElement
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

// Neutral dark theme: bg matches the dark --paper-pane (#191919, the main content surface the terminal
// fills — kept in lockstep with tokens.css so the canvas and its surrounding pane read as one), fg is
// the dark --ink, and the ANSI palette is lifted to read on the dark surface. Neutral grays (no warm
// cast); chromatic slots stay vivid. Cobalt selection at a higher alpha for contrast.
// xterm's theme takes literal colors — it cannot read a CSS variable — so these two MUST be updated
// by hand whenever --paper-pane moves, or the terminal seams against the pane it sits in.
const DARK_THEME = {
  background: '#191919',
  foreground: '#f2f2f2',
  cursor: 'rgba(0,0,0,0)',
  cursorAccent: '#191919',
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

const CODEX_REFRESH_FOLLOW_MS = 1000
// Independent ceiling; matching the refresh window is incidental, not a shared tuning parameter.
const CODEX_REPLAY_FOLLOW_MS = 1000
const CODEX_REPLAY_FOLLOW_IDLE_MS = 250
const CODEX_BOTTOM_PIN_TOLERANCE_ROWS = 1

export default function TerminalView({
  mountNode,
  ptyId,
  sessionId,
  agent,
  visible,
  focusKey,
  theme,
  onMarkUnread
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastSentRef = useRef<{ cols: number; rows: number } | null>(null)
  // rAF handle coalescing the post-output scroll-area recompute to one call per frame (see syncScrollArea).
  const syncRafRef = useRef<number | null>(null)
  const refreshFollowUntilRef = useRef(0)
  const replayFollowRef = useRef(false)
  const replayFollowUntilRef = useRef(0)
  const replayFollowTimerRef = useRef<number | null>(null)
  const restoringHandoffRef = useRef(false)
  // -Infinity, not 0: `performance.now()` counts from page load, so a zero start would compare the
  // first report against the renderer's own age and swallow every use during its first throttle
  // window — silently, and with no trailing flush to recover it.
  const lastUsedReportRef = useRef(Number.NEGATIVE_INFINITY)

  /**
   * "A person used this terminal", which decides whether the live-session cap may reclaim it.
   *
   * Deliberately NOT derived from `onData`: xterm answers an agent's startup terminal queries
   * (device attributes, cursor position) through that same channel, so treating written bytes as
   * input marks every terminal used within milliseconds of booting — and then no untouched terminal
   * is ever reclaimable.
   *
   * Callers must therefore cover every way a person supplies input, and `onKey` alone does not:
   * pasted text and an IME composition commit both reach the process without a key event. Missing
   * one means a terminal holding a real draft is ranked as empty and discarded first.
   *
   * Throttled because the cap orders by recency in minutes: per-keystroke precision buys nothing and
   * this sits on the typing path.
   */
  const markUsed = useCallback((): void => {
    const now = performance.now()
    if (now - lastUsedReportRef.current < 5000) return
    lastUsedReportRef.current = now
    window.api.reportTerminalUsed(ptyId)
  }, [ptyId])

  const attachHostRef = useCallback((node: HTMLDivElement | null): void => {
    hostRef.current = node
    const element = termRef.current?.element
    if (node && element && element.parentElement !== node) node.appendChild(element)
  }, [])

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
    const stagedSnapshot = pendingPtySnapshot(ptyId)
    restoringHandoffRef.current = !!stagedSnapshot

    const term = new Terminal({
      cols: stagedSnapshot?.cols,
      rows: stagedSnapshot?.rows,
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
    const serialize = new SerializeAddon()
    term.loadAddon(fit)
    term.loadAddon(serialize)
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

    const stopReplayFollow = (): void => {
      if (replayFollowTimerRef.current != null) {
        window.clearTimeout(replayFollowTimerRef.current)
        replayFollowTimerRef.current = null
      }
      replayFollowRef.current = false
      replayFollowUntilRef.current = 0
    }

    const scheduleReplayFollowEnd = (): void => {
      if (replayFollowTimerRef.current != null) {
        window.clearTimeout(replayFollowTimerRef.current)
      }
      const remainingMs = replayFollowUntilRef.current - performance.now()
      replayFollowTimerRef.current = window.setTimeout(() => {
        replayFollowTimerRef.current = null
        replayFollowRef.current = false
        replayFollowUntilRef.current = 0
      }, Math.max(0, Math.min(CODEX_REPLAY_FOLLOW_IDLE_MS, remainingMs)))
    }

    // Codex sometimes replaces its terminal history with ED2 + ED3 followed by a bounded replay
    // (not only on resize — plan completion does this too). xterm preserves its user-scrolling flag
    // across ED3, so a viewport that lagged even one row behind the bottom stays at replay row zero.
    // Observe ED3 before xterm's built-in handler runs; returning false preserves normal handling.
    // A one-row tolerance absorbs that transient lag, while a genuinely scrolled-up viewport stays
    // detached from the bottom. The write callback below follows only the ensuing replay burst,
    // bounded by both output idle time and an absolute deadline.
    const scrollbackReset =
      agent === 'codex'
        ? term.parser.registerCsiHandler({ final: 'J' }, (params) => {
            if (params[0] !== 3) return false
            stopReplayFollow()
            const buffer = term.buffer.active
            replayFollowRef.current =
              buffer.baseY - buffer.viewportY <= CODEX_BOTTOM_PIN_TOLERANCE_ROWS
            if (replayFollowRef.current) {
              replayFollowUntilRef.current = performance.now() + CODEX_REPLAY_FOLLOW_MS
            }
            return false
          })
        : null

    // Send a top-anchored SU's displaced rows to scrollback instead of destroying them (see
    // xtermScrollUp). Registered for BOTH agents and gated on the BUFFER, not the agent: scrollback
    // is a property of the normal buffer, so an alternate-screen TUI declines on its own and needs
    // no agent branch. Installed before attachPty so it is in place for the first byte.
    const safeScrollUp = installScrollbackSafeScrollUp(term)

    // Size the terminal to its container BEFORE the PTY backlog floods in. On resume the host is
    // already visible (display:block) and measurable, so this synchronous fit resizes the still-
    // empty renderer once, up front — instead of letting claude's replay flood paint at the
    // default 80×24 and then paying a ~170ms WebGL resize mid-flood (the trace's single worst
    // main-thread task on resume, ~950ms in). The rAF + ResizeObserver below stay as the fallback
    // for when the host isn't measurable yet (created while hidden) and for later/window resizes.
    if (!stagedSnapshot) fitAndResize()

    const snapshot = (): PtySnapshot => {
      const buffer = term.buffer.active
      return {
        data: serialize.serialize({ scrollback: HANDOFF_SCROLLBACK_ROWS }),
        cols: term.cols,
        rows: term.rows,
        viewportFromBottom: Math.min(
          HANDOFF_SCROLLBACK_ROWS,
          Math.max(0, buffer.baseY - buffer.viewportY)
        )
      }
    }

    const restored = (saved: PtySnapshot): void => {
      const buffer = term.buffer.active
      if (saved.viewportFromBottom > 0) {
        term.scrollToLine(Math.max(0, buffer.baseY - saved.viewportFromBottom))
      }
      restoringHandoffRef.current = false
      fitAndResize()
      if (agent === 'codex') syncScrollArea(term)
      window.api.confirmPtySnapshotRestored(ptyId)
    }

    // After Codex output, recompute the scrollbar range so the newest rows stay reachable (see
    // syncScrollArea) — coalesced to one call per frame regardless of how many chunks arrived. Claude
    // is alternate-screen (no scrollback), so it keeps the plain write with zero added per-output work.
    const detach =
      agent === 'codex'
        ? attachPty(ptyId, (d, done) => {
            term.write(d, () => {
              done()
              const now = performance.now()
              const followingReplay =
                replayFollowRef.current && now < replayFollowUntilRef.current
              if (replayFollowRef.current && !followingReplay) stopReplayFollow()
              if (now < refreshFollowUntilRef.current || followingReplay) {
                term.scrollToBottom()
                syncScrollArea(term)
                if (followingReplay) scheduleReplayFollowEnd()
                return
              }
              if (syncRafRef.current != null) return
              syncRafRef.current = requestAnimationFrame(() => {
                syncRafRef.current = null
                const t = termRef.current
                if (t) syncScrollArea(t)
              })
            })
          }, snapshot, restored)
        : attachPty(ptyId, (d, done) => term.write(d, done), snapshot, restored)
    const followRefreshScroll =
      agent === 'codex'
        ? term.onScroll((viewportY) => {
            if (performance.now() >= refreshFollowUntilRef.current) return
            if (viewportY === term.buffer.active.baseY) return
            term.scrollToBottom()
            syncScrollArea(term)
          })
        : null
    const onInput = term.onData((d) => window.api.sendInput(ptyId, d))

    // `onKey` fires only from a real DOM keyboard event, unlike `onData` — see markUsed. It covers
    // every key press including ones that insert nothing (Enter, arrows), but NOT text that arrives
    // without a key: a paste, an IME commit, an emoji picker, a native insertText.
    const onRealKey = term.onKey(markUsed)
    // Those all surface as an `input` on xterm's own textarea, and nothing else does — the
    // automatic replies to terminal queries are generated in JS and never touch it, so this cannot
    // reintroduce the boot-time false positive. Paste and composition keep their explicit reports
    // below as well: whether a paste reaches the textarea at all depends on a third party not
    // calling preventDefault, and this is not an area to rest correctness on that.
    const onTextInput = (e: Event): void => {
      if ((e as InputEvent).data || (e.target as HTMLTextAreaElement | null)?.value) markUsed()
    }
    term.textarea?.addEventListener('input', onTextInput)

    // Image input is agent-specific. Claude reads the clipboard after an empty bracketed paste;
    // Codex reserves the real Ctrl+V key and reads the clipboard from that key event.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyV') {
        window.api.sendInput(ptyId, agent === 'codex' ? '\x16' : '\x1b[200~\x1b[201~')
        markUsed()
        return false
      }
      return true
    })

    const offExit = window.api.onPtyExit((id, code) => {
      if (id === ptyId) {
        term.write(`\r\n\x1b[2m—— session ended (exit ${code ?? 0}) ——\x1b[0m\r\n`)
      }
    })

    return () => {
      if (syncRafRef.current != null) cancelAnimationFrame(syncRafRef.current)
      syncRafRef.current = null
      stopReplayFollow()
      offExit()
      onInput.dispose()
      onRealKey.dispose()
      term.textarea?.removeEventListener('input', onTextInput)
      followRefreshScroll?.dispose()
      detach()
      scrollbackReset?.dispose()
      safeScrollUp.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      lastSentRef.current = null
    }
  }, [ptyId, agent, fitAndResize, markUsed])

  // The React component is window-owned and stable; only this DOM host moves between pane portals.
  // Rebind host-local listeners and sizing without touching the xterm, its parser, or its scrollback.
  useEffect(() => {
    const host = hostRef.current
    if (!host || !termRef.current) return
    const fitWhenReady = (): void => {
      if (!restoringHandoffRef.current) fitAndResize()
    }
    const onDragOver = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length === 0) return
      const paths = files.map((f) => escapePath(window.api.getPathForFile(f))).join(' ')
      window.api.sendInput(ptyId, `\x1b[200~${paths}\x1b[201~`)
      markUsed()
    }
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      // xterm handles the paste itself and emits it through `onData`, which fires no key event —
      // so without this a pasted draft leaves the terminal looking untouched.
      markUsed()
    }
    // An IME commit likewise reaches the process without a key event.
    const onCompositionEnd = (e: CompositionEvent): void => {
      if (e.data) markUsed()
    }
    const raf = requestAnimationFrame(fitWhenReady)
    const ro = new ResizeObserver(fitWhenReady)
    ro.observe(host)
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)
    host.addEventListener('paste', onPaste, true)
    host.addEventListener('compositionend', onCompositionEnd, true)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      host.removeEventListener('paste', onPaste, true)
      host.removeEventListener('compositionend', onCompositionEnd, true)
    }
  }, [mountNode, ptyId, fitAndResize, markUsed])

  // Re-skin the terminal when the app theme flips. xterm applies term.options.theme live (re-reads
  // the palette and repaints), so a running claude session recolors in place — no remount. The
  // construction effect captures the initial theme; this owns every subsequent change.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = THEMES[theme]
  }, [theme])

  // Codex clears and rebuilds its scrollback on the resize-driven refresh. Snap before the zoom
  // wiggle starts so xterm enters that replay in follow-output mode and finishes at the bottom.
  // Only the visible Codex terminal moves; Claude and hidden live sessions keep their positions.
  useEffect(() => {
    if (agent !== 'codex' || !visible) return
    return window.api.onRefreshStart(() => {
      const term = termRef.current
      if (!term) return
      refreshFollowUntilRef.current = performance.now() + CODEX_REFRESH_FOLLOW_MS
      term.scrollToBottom()
      syncScrollArea(term)
    })
  }, [agent, visible, ptyId])

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
  }, [mountNode, sessionId, onMarkUnread])

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
    // `mountNode` belongs here for the same reason `visible` does. Moving a tab between panes
    // re-parents this terminal's host, and detaching an element from the document is another way
    // xterm's observer sees it stop intersecting — but `visible` stays true across the move, so
    // without this dep the effect never re-runs and the terminal can sit frozen on its last frame
    // in its new pane. The re-parent effect above already treats `mountNode` as a stable dep.
  }, [visible, mountNode, ptyId, agent, fitAndResize])

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

  return createPortal(
    <div className="sb-term-host" style={{ display: visible ? 'block' : 'none' }}>
      <div className="sb-term" ref={attachHostRef} />
    </div>,
    mountNode,
    ptyId
  )
}
