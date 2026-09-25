import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { AgentKind } from '@shared/types'
import type { SidebarBlock, SidebarModel, SidebarRow } from '../lib/sidebarModel'
import { visibleRows } from '../lib/sidebarModel'
import type { RailDensity, SidebarMode } from '../lib/sidebarPrefs'
import { rowTipMeta } from '../lib/rowTip'
import { useRailFlip } from '../lib/useRailFlip'
import { useBlockReorder, type BlockDrop } from '../lib/useBlockReorder'
import { foldFolder } from '../lib/folderFold'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'
import { useOverflowFade } from '../lib/useOverflowFade'
import ConversationRow from './ConversationRow'
import SidebarHead from './SidebarHead'
import SidebarGroupHeader from './SidebarGroupHeader'
import { isUnlinkedRow } from '../lib/rowIdentity'
import { Pin, Info, NewWindow, SplitVertical, Stop, Play } from './icons'

interface Props {
  /** What to draw — built in App by `buildSidebar`, which keyboard navigation walks too. */
  model: SidebarModel
  mode: SidebarMode
  onModeChange: (mode: SidebarMode) => void
  density: RailDensity
  /** Focus the next session that needs you (the head tag), cycling. */
  onNeedsYou: () => void
  /** Collapse all / Expand all. */
  onSetAllCollapsed: (collapsed: boolean) => void
  /** True during the initial conversation index, before the model is populated. */
  loading: boolean
  /** Conversations another window holds tabs for — those rows are marked, since clicking one raises
   *  that window instead of opening here. */
  openElsewhere: Set<string>
  selectedSessionId: string | null
  onJump: (sessionId: string) => void
  onSelect: (sessionId: string) => void
  /** Double-click a row — keep its tab. Undefined while tabs are switched off. */
  onStick?: (sessionId: string) => void
  /** The ⋮ menu's Open to the Side — show it in the other pane. */
  onOpenToSide?: (sessionId: string) => void
  canOpenToSide?: (sessionId: string) => boolean
  /** The ⋮ menu's Open in New Window — a separate window showing just this conversation. */
  onOpenInNewWindow?: (sessionId: string) => void
  onTogglePin: (sessionId: string) => void
  query: string
  onQueryChange: (q: string) => void
  searchRef: RefObject<HTMLInputElement>
  searchOpen: boolean
  onSearchToggle: () => void
  /** True when a query is active — every folder renders expanded and uncapped, and drags are off. */
  searching: boolean
  /** A folder header's chevron — writes that folder's collapse preference. */
  onToggleFolder: (root: string) => void
  /** Extra rows revealed per group key (ephemeral). */
  revealed: Readonly<Record<string, number>>
  onShowMore: (key: string) => void
  onShowLess: (key: string) => void
  menuOpen: boolean
  onMenuToggle: () => void
  onNewContextMenu: () => void
  onMenuClose: () => void
  recentDirs: string[]
  menuDefaultDir: string
  menuAgents: AgentKind[]
  menuAgent: AgentKind
  onMenuAgentChange: (agent: AgentKind) => void
  onChoose: (cwd: string, agent: AgentKind) => void
  onPickOther: (agent: AgentKind) => void
  defaultDirActive: boolean
  defaultDirLabel: string
  /** Toggle a conversation read/unread (from its right-click menu). */
  onToggleUnread: (id: string) => void
  /** Option+click a live row — always mark it unread (never toggles). */
  onMarkUnread: (id: string) => void
  /** Resume a not-live conversation from its right-click menu (spawns + focuses its terminal). */
  onResumeSession: (id: string) => void
  /** Stop (kill) a live session from its right-click menu. No-op on a not-live row. */
  onStopSession: (id: string) => void
  /** Open the conversation-info modal for a row (the right-click "Session details…" item). `edit`
   *  starts it in title-edit mode. */
  onShowInfo: (id: string, edit: boolean) => void
  /** A row dropped between two neighbors of its block, either null at an edge. */
  onDropRow: (block: SidebarBlock, draggedId: string, higherId: string | null, lowerId: string | null) => void
  /** A folder dropped between two neighboring folders, either null at an edge. */
  onDropFolder: (root: string, higherRoot: string | null, lowerRoot: string | null) => void
  /** Bumped on each drag-reorder commit; folded into controlSig so that commit settles instantly. */
  reorderTick: number
}

/** The drag block holding the folders themselves, in Folders mode — the rail body. */
const FOLDERS_BLOCK = 'folders'

/**
 * The unified conversation pane. A head (grouping mode, the needs-you tag, search, new) above one
 * scrolling list of groups: one headerless group in All mode, one sticky-headed group per project in
 * Folders mode. Every group holds its pinned rows, then its unpinned ones; liveness is the dot, never
 * a grouping.
 */
export default function Sidebar({
  model,
  mode,
  onModeChange,
  density,
  onNeedsYou,
  onSetAllCollapsed,
  loading,
  openElsewhere,
  selectedSessionId,
  onJump,
  onSelect,
  onStick,
  onOpenToSide,
  canOpenToSide,
  onOpenInNewWindow,
  onTogglePin,
  query,
  onQueryChange,
  searchRef,
  searchOpen,
  onSearchToggle,
  searching,
  onToggleFolder,
  revealed,
  onShowMore,
  onShowLess,
  menuOpen,
  onMenuToggle,
  onNewContextMenu,
  onMenuClose,
  recentDirs,
  menuDefaultDir,
  menuAgents,
  menuAgent,
  onMenuAgentChange,
  onChoose,
  onPickOther,
  defaultDirActive,
  defaultDirLabel,
  onToggleUnread,
  onMarkUnread,
  onResumeSession,
  onStopSession,
  onShowInfo,
  onDropRow,
  onDropFolder,
  reorderTick
}: Props) {
  // Nothing to draw: no folder has a row, or All mode's one group is empty. A collapsed folder is not
  // empty — it has rows, just not on screen.
  const empty = model.groups.every((g) => g.blocks.length === 0 && !g.collapsed)

  // Obsidian-style scrollbar: the thumb shows only while scrolling (+ a beat after), never at rest.
  const listRef = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(listRef)
  // Fade the last rows when the list overflows and isn't scrolled to the bottom (more below).
  useOverflowFade(listRef)

  // Divider under the head: shown only once the list is scrolled off the top (none at the very top),
  // so the head reads as a fixed band separated from the content it sits above. Driven off the body's
  // scrollTop — a boolean, so setState is a no-op re-render until it actually flips (no per-event cost).
  const [scrolled, setScrolled] = useState(false)

  const shown = visibleRows(model)
  // Glide rows that change position (pinned / resumed / unpinned) instead of teleporting. orderSig
  // (the visible ids, in order) drives a slide; controlSig (search, mode, collapse, reveal) marks a
  // layout change we deliberately keep instant — see useRailFlip.
  const orderSig = shown.map((r) => r.sessionId).join('|')
  const controlSig = JSON.stringify([
    query,
    mode,
    density,
    model.groups.map((g) => [g.key, g.collapsed]),
    revealed,
    reorderTick
  ])
  // One drag gesture for the whole rail. A drag never leaves its block — a row stays among its folder's
  // pinned or unpinned rows, a folder among folders — and reports the two neighbors it landed between,
  // which is what both a rank write and a pin move need. Declared BEFORE useRailFlip: a committed drop's
  // layout effect clears the siblings' drag transforms, and the flip must measure the rows after that.
  const onDrop = useCallback(
    (drop: BlockDrop) => {
      if (drop.block === FOLDERS_BLOCK) return onDropFolder(drop.key, drop.above, drop.below)
      const block = model.groups.flatMap((g) => g.blocks).find((b) => b.id === drop.block)
      if (block) onDropRow(block, drop.key, drop.above, drop.below)
    },
    [model, onDropRow, onDropFolder]
  )
  useBlockReorder(listRef, {
    enabled: !searching,
    onDrop,
    commitKey: reorderTick,
    cancelKey: JSON.stringify([mode, density, searchOpen, searching]),
    // Moving a folder folds it to its header, so it moves as one short card.
    reshape: (block, unit) => (block === FOLDERS_BLOCK ? foldFolder(unit) : null)
  })

  useRailFlip(listRef, orderSig, controlSig)


  // Re-evaluate the head divider when the visible content changes: collapsing a folder or running a
  // search can shrink the list back within the viewport (scrollTop snaps to 0) WITHOUT firing a scroll
  // event, which would otherwise leave the divider stuck on.
  useEffect(() => {
    const el = listRef.current
    if (el) setScrolled(el.scrollTop > 0)
  }, [orderSig, controlSig])

  // Look up a rendered row by id — used by the right-click menu, which only rendered rows can open.
  const entryById = (id: string): SidebarRow | undefined => shown.find((r) => r.sessionId === id)

  // Row actions menu, on any row (live or not): Pin/Unpin, plus — live — mark read/unread + Stop, or —
  // not-live — Resume, and Session details. One shared instance, opened by CLICKING the ⋮ button
  // (anchored under it) or right-clicking (at the cursor); dismissed by an outside click, Esc, or scroll.
  const [ctxMenu, setCtxMenu] = useState<{
    id: string
    /** viewport coords; `left` for a cursor (right-click) anchor, `right` for the ⋮-button anchor. */
    top: number
    left?: number
    right?: number
    live: boolean
    unread: boolean
    pinned: boolean
    unlinked: boolean
    side: boolean
  } | null>(null)
  const menuStateFor = (
    id: string
  ): { live: boolean; unread: boolean; pinned: boolean; unlinked: boolean; side: boolean } | null => {
    const entry = entryById(id)
    if (!entry) return null
    return {
      live: !!entry.pty,
      unread: entry.liveState === 'awaiting' || entry.liveState === 'asking',
      pinned: entry.pinned,
      side: canOpenToSide?.(id) ?? false,
      // Pin, read state, and session details are all keyed to a conversation this row does not have,
      // so they would silently do nothing. Hide them rather than offer a no-op.
      unlinked: isUnlinkedRow(entry.pty, entry.meta)
    }
  }
  // `closing` drives the fade-out: the menu stays mounted with a `.closing` class for one fade, then
  // unmounts (so it dissolves instead of vanishing). `closeTimerRef` is the inactivity auto-dismiss;
  // `fadeTimerRef` is the fade→unmount delay.
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef<number | null>(null)
  const fadeTimerRef = useRef<number | null>(null)
  const cancelAutoClose = (): void => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }
  // Fade out, then unmount. Idempotent while a fade is already running.
  const closeMenu = (): void => {
    cancelAutoClose()
    if (fadeTimerRef.current != null) return
    setClosing(true)
    fadeTimerRef.current = window.setTimeout(() => {
      setCtxMenu(null)
      setClosing(false)
      fadeTimerRef.current = null
    }, 440)
  }
  // Auto-dismiss: once open, fade out after a grace UNLESS the pointer is over the menu. Entering the
  // menu cancels the timer (never closes while hovered); leaving re-arms it.
  const armAutoClose = (): void => {
    cancelAutoClose()
    closeTimerRef.current = window.setTimeout(closeMenu, 1500)
  }
  // Open (or re-open) the menu — cancel any in-flight fade so it snaps back to fully shown.
  const openMenu = (data: NonNullable<typeof ctxMenu>): void => {
    if (fadeTimerRef.current != null) {
      clearTimeout(fadeTimerRef.current)
      fadeTimerRef.current = null
    }
    setClosing(false)
    setCtxMenu(data)
    armAutoClose()
  }
  // Right-click / two-finger: open at the cursor.
  const openRowMenu = (e: MouseEvent, id: string): void => {
    const s = menuStateFor(id)
    if (!s) return
    openMenu({ id, top: e.clientY, left: e.clientX, ...s })
  }
  // The ⋮ button (click): TOGGLE — close if this row's menu is already open, else open anchored under
  // the button's right edge. Read the rect synchronously — React nulls currentTarget after the handler.
  const openRowMenuFromButton = (e: MouseEvent, id: string): void => {
    if (ctxMenu && ctxMenu.id === id && !closing) {
      closeMenu()
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const s = menuStateFor(id)
    if (!s) return
    openMenu({ id, top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right), ...s })
  }
  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    // Scroll-to-close is scoped to the RAIL body, not a document-wide capture listener. The menu is
    // viewport-fixed but anchored to a rail row, so only a list scroll detaches it. A `document`
    // capture listener also caught the transcript pane's scrolls — and opening a large conversation
    // re-pins to the bottom for 1–2s (window-grow + tool-result overflow settle), spamming scroll
    // events that slammed the menu shut the instant it opened. Scroll events don't bubble, so a
    // listener on the rail body fires only for rail scrolls.
    const railBody = listRef.current
    document.addEventListener('click', closeMenu)
    document.addEventListener('keydown', onKey)
    railBody?.addEventListener('scroll', closeMenu)
    return () => {
      document.removeEventListener('click', closeMenu)
      document.removeEventListener('keydown', onKey)
      railBody?.removeEventListener('scroll', closeMenu)
    }
  }, [ctxMenu])
  // Clear pending timers on unmount.
  useEffect(
    () => () => {
      cancelAutoClose()
      if (fadeTimerRef.current != null) clearTimeout(fadeTimerRef.current)
    },
    []
  )

  const renderRow = (row: SidebarRow): ReactNode => {
    const root = model.rows.get(row.sessionId)?.root ?? row.meta.cwd
    return (
      <ConversationRow
        key={row.sessionId}
        meta={row.meta}
        density={density}
        selected={row.sessionId === selectedSessionId}
        tipMeta={rowTipMeta(model.labels.get(root) ?? '', row.meta.cwd, root, {
        background: row.meta.agent === 'claude' && row.meta.sessionKind === 'bg',
        elsewhere: openElsewhere.has(row.sessionId)
      })}
        live={row.pty}
        liveState={row.liveState}
        pinned={row.pinned}
        elsewhere={openElsewhere.has(row.sessionId)}
        onSelect={onSelect}
        onJump={onJump}
        onStick={onStick}
        // onOpenToSide / onOpenInNewWindow are deliberately NOT passed down: they are menu actions now,
        // not click gestures. The rail still holds them for its own ⋮ and right-click menus below.
        onMarkUnread={onMarkUnread}
        onOpenMenu={openRowMenuFromButton}
        onContextMenu={openRowMenu}
      />
    )
  }

  return (
    <aside className={`sb-rail ${density}`}>
      <SidebarHead
        scrolled={scrolled}
        mode={mode}
        onModeChange={onModeChange}
        needsYou={model.needsYou.length}
        onNeedsYou={onNeedsYou}
        onSetAllCollapsed={onSetAllCollapsed}
        query={query}
        onQueryChange={onQueryChange}
        searchRef={searchRef}
        searchOpen={searchOpen}
        onSearchToggle={onSearchToggle}
        menuOpen={menuOpen}
        onMenuToggle={onMenuToggle}
        onNewContextMenu={onNewContextMenu}
        onMenuClose={onMenuClose}
        recentDirs={recentDirs}
        menuDefaultDir={menuDefaultDir}
        menuAgents={menuAgents}
        menuAgent={menuAgent}
        onMenuAgentChange={onMenuAgentChange}
        onChoose={onChoose}
        onPickOther={onPickOther}
        defaultDirActive={defaultDirActive}
        defaultDirLabel={defaultDirLabel}
      />

      <div
        className="sb-rail-body sb-autoscroll"
        ref={listRef}
        data-block={mode === 'folders' ? FOLDERS_BLOCK : undefined}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {loading ? (
          <div className="sb-rail-empty">
            <div className="sb-rail-empty-mark" />
            <div className="label-caps">Indexing conversations…</div>
          </div>
        ) : empty ? (
          <div className="sb-rail-empty">
            <div className="sb-rail-empty-mark" />
            <div className="label-caps">{searching ? 'No matches' : 'No conversations yet'}</div>
            {!searching && (
              <div className="sb-rail-empty-hint">Start or resume a conversation and it&apos;ll show up here.</div>
            )}
          </div>
        ) : (
          model.groups.map((g) => {
            const extra = revealed[g.key] ?? 0
            const more = !g.collapsed && !searching && g.hidden > 0
            const less = !g.collapsed && !searching && extra > 0
            // Compact draws no rules, so the space closing each expanded folder is what separates it
            // from the next — reserved whether or not there is anything to show more of, so every
            // break is the same size.
            const reserve = density === 'compact' && g.header && !g.collapsed
            return (
              <section key={g.key} className="sb-group" data-key={g.header ? g.key : undefined}>
                {g.header && (
                  <SidebarGroupHeader
                    root={g.key}
                    label={g.label}
                    collapsed={g.collapsed}
                    wantsAttention={g.wantsAttention}
                    onToggle={onToggleFolder}
                  />
                )}
                {g.blocks.map((b) => (
                  <div key={b.id} className="sb-block" data-block={b.id}>
                    {b.rows.map(renderRow)}
                  </div>
                ))}
                {(more || less || reserve) && (
                  <div className="sb-rail-more-row">
                    {more && (
                      <button className="sb-rail-more" onClick={() => onShowMore(g.key)}>
                        Show more
                      </button>
                    )}
                    {less && (
                      <button className="sb-rail-more" onClick={() => onShowLess(g.key)}>
                        Show less
                      </button>
                    )}
                  </div>
                )}
              </section>
            )
          })
        )}
      </div>

      {ctxMenu && (
        <div
          className={`sb-ctxmenu${closing ? ' closing' : ''}`}
          style={{ top: ctxMenu.top, left: ctxMenu.left, right: ctxMenu.right }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={cancelAutoClose}
          onMouseLeave={armAutoClose}
        >
          {!ctxMenu.unlinked && (
            <button
              className="sb-ctxmenu-item"
              onClick={() => {
                onTogglePin(ctxMenu.id)
                closeMenu()
              }}
            >
              <Pin size={13} filled={!ctxMenu.pinned} />
              <span>{ctxMenu.pinned ? 'Unpin' : 'Pin'}</span>
            </button>
          )}
          {ctxMenu.live && !ctxMenu.unlinked && (
            <button
              className="sb-ctxmenu-item"
              onClick={() => {
                onToggleUnread(ctxMenu.id)
                closeMenu()
              }}
            >
              <span className={`sb-menu-dot ${ctxMenu.unread ? 'hollow' : 'filled'}`} aria-hidden="true" />
              <span>{ctxMenu.unread ? 'Mark as read' : 'Mark as unread'}</span>
            </button>
          )}
          {!ctxMenu.unlinked && (
            <button
              className="sb-ctxmenu-item"
              onClick={() => {
                onShowInfo(ctxMenu.id, false)
                closeMenu()
              }}
            >
              <Info size={14} />
              <span>Session details…</span>
            </button>
          )}
          {/* Sits with the benign items rather than behind the destructive divider: it opens a view,
              it does not start or stop anything. Hidden on an unlinked row for the same reason the
              three above are — a terminal with no conversation has no transcript to show beside one. */}
          {onOpenToSide && ctxMenu.side && !ctxMenu.unlinked && (
            <button
              className="sb-ctxmenu-item"
              onClick={() => {
                onOpenToSide(ctxMenu.id)
                closeMenu()
              }}
            >
              <SplitVertical size={14} />
              <span>Open to the side</span>
            </button>
          )}
          {onOpenInNewWindow && !ctxMenu.unlinked && (
            <button
              className="sb-ctxmenu-item"
              onClick={() => {
                onOpenInNewWindow(ctxMenu.id)
                closeMenu()
              }}
            >
              <NewWindow size={14} />
              <span>Open in new window</span>
            </button>
          )}
          {/* The session action sits at the bottom behind a divider — **Stop** (live) or **Resume**
              (not-live) — so the two always occupy the same slot. Separated from the benign items above. */}
          {!ctxMenu.unlinked && <div className="sb-ctxmenu-sep" />}
          {ctxMenu.live ? (
            <button
              className="sb-ctxmenu-item danger"
              onClick={() => {
                onStopSession(ctxMenu.id)
                closeMenu()
              }}
            >
              <Stop size={14} />
              <span>Stop session</span>
            </button>
          ) : (
            <button
              className="sb-ctxmenu-item live"
              onClick={() => {
                onResumeSession(ctxMenu.id)
                closeMenu()
              }}
            >
              <Play size={14} />
              <span>Resume</span>
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
