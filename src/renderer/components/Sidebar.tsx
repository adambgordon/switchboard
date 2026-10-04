import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { AgentKind } from '@shared/types'
import type { SidebarBlock, SidebarModel, SidebarRow } from '../lib/sidebarModel'
import { visibleRows } from '../lib/sidebarModel'
import type { RailDensity, SidebarMode } from '../lib/sidebarPrefs'
import { rowTipMeta } from '../lib/rowTip'
import { placeTip } from '../lib/tooltip'
import { useRailFlip } from '../lib/useRailFlip'
import { useBlockReorder, type BlockDrop } from '../lib/useBlockReorder'
import { foldFolder } from '../lib/folderFold'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'
import { useOverflowFade } from '../lib/useOverflowFade'
import ConversationRow from './ConversationRow'
import SidebarHead from './SidebarHead'
import SidebarGroupHeader from './SidebarGroupHeader'
import { isUnlinkedRow } from '../lib/rowIdentity'
import { conversationMenu, folderMenu, type SidePlace } from '../lib/conversationMenu'
import type { RailFilter } from '../lib/railFilter'
import type { ConversationMenuAction, ConversationMenuEntry } from '@shared/types'
import { Pin, Info, NewWindow, Rename, SplitVertical, Stop, Play, Eye, EyeOff } from './icons'

interface Props {
  /** What to draw — built in App by `buildSidebar`, which keyboard navigation walks too. */
  model: SidebarModel
  mode: SidebarMode
  onModeChange: (mode: SidebarMode) => void
  density: RailDensity
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
  /** Where "to the side" would put the conversation (null when it cannot go), and whether this window
   *  already holds a tab for it — what the menu needs to name its where-to commands. */
  placementFor?: (sessionId: string) => { side: SidePlace | null; hasTabHere: boolean }
  /** The ⋮ menu's Open in New Window — a separate window showing just this conversation. */
  onOpenInNewWindow?: (sessionId: string) => void
  onTogglePin: (sessionId: string) => void
  /** Which conversations the rail shows (`railFilter`). Drags are off while any criterion is set. */
  filter: RailFilter
  onFilterChange: (filter: RailFilter) => void
  onSetConversationHidden: (sessionId: string, hidden: boolean) => void
  onSetFolderHidden: (root: string, hidden: boolean) => void
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
  /** The head's pencil: a new-conversation chooser (⌘N). */
  onNewConversation: () => void
  /** Installed agents: each folder header's logos. */
  agents: AgentKind[]
  /** A folder's pencil: the new-conversation chooser with that folder preselected. */
  onNewInFolder: (root: string) => void
  /** ⇧-click on a pencil or an agent logo: its new conversation, in a new window. A null folder is the
   *  head pencil's — "where I am". Absent while new windows are unavailable. */
  onNewInWindow?: (root: string | null, agent?: AgentKind) => void
  /** A folder's agent logo: start that agent in the folder straight away. */
  onStartInFolder: (root: string, agent: AgentKind) => void
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

/** A row-menu command's glyph. The pin and the dot show what the command will make, not what is. */
function menuIcon(action: ConversationMenuAction): ReactNode {
  switch (action) {
    case 'resume':
      return <Play size={14} />
    case 'toSide':
      return <SplitVertical size={14} />
    case 'newWindow':
      return <NewWindow size={14} />
    case 'pin':
      return <Pin size={13} filled />
    case 'unpin':
      return <Pin size={13} />
    case 'markRead':
      return <span className="sb-menu-dot hollow" aria-hidden="true" />
    case 'markUnread':
      return <span className="sb-menu-dot filled" aria-hidden="true" />
    case 'hide':
    case 'hideFolder':
      return <EyeOff size={14} />
    case 'unhide':
    case 'unhideFolder':
      return <Eye size={14} />
    case 'rename':
      return <Rename size={14} />
    case 'details':
      return <Info size={14} />
    case 'stop':
      return <Stop size={14} />
    default:
      return null
  }
}
/** The smallest margin the row menu keeps from the window's edges. */
const MENU_EDGE = 8

/**
 * An empty rail says why it is empty, and when the filter is the reason, offers the way out: an empty
 * list must never read as conversations that are gone.
 */
function EmptyRail({
  searching,
  filter,
  filteredOut,
  onFilterChange
}: {
  searching: boolean
  filter: RailFilter
  /** What the filter keeps out that the search, if any, matches. */
  filteredOut: number
  onFilterChange: (filter: RailFilter) => void
}) {
  const filtering = filter.size > 0
  const only = filter.size === 1 ? [...filter][0] : null
  const title = searching
    ? 'No matches'
    : only === 'hidden'
      ? 'Nothing hidden'
      : only === 'live'
        ? 'No live conversations'
        : filtering
          ? 'No matches'
          : filteredOut > 0
            ? 'All conversations are hidden'
            : 'No conversations yet'
  // Unfiltered, what the filter keeps out is exactly what is hidden.
  const outside = filtering
    ? `${filteredOut} more outside the filter`
    : `${filteredOut} hidden ${filteredOut === 1 ? 'conversation matches' : 'conversations match'}`
  return (
    <div className="sb-rail-empty">
      <div className="sb-rail-empty-mark" />
      <div className="label-caps">{title}</div>
      {filtering ? (
        <>
          {filteredOut > 0 && <div className="sb-rail-empty-hint">{outside}</div>}
          <button className="sb-rail-more" onClick={() => onFilterChange(new Set())}>
            Clear filters
          </button>
        </>
      ) : filteredOut > 0 ? (
        <>
          {searching && <div className="sb-rail-empty-hint">{outside}</div>}
          <button className="sb-rail-more" onClick={() => onFilterChange(new Set(['hidden']))}>
            Show hidden
          </button>
        </>
      ) : (
        !searching && <div className="sb-rail-empty-hint">Start or resume a conversation and it&apos;ll show up here.</div>
      )}
    </div>
  )
}

/**
 * The unified conversation pane. A head (grouping mode, search, new) above one
 * scrolling list of groups: one headerless group in All mode, one sticky-headed group per project in
 * Folders mode. Every group holds its pinned rows, then its unpinned ones; liveness is the dot, never
 * a grouping.
 */
export default function Sidebar({
  model,
  mode,
  onModeChange,
  density,
  onSetAllCollapsed,
  loading,
  openElsewhere,
  selectedSessionId,
  onJump,
  onSelect,
  onStick,
  onOpenToSide,
  placementFor,
  onOpenInNewWindow,
  onTogglePin,
  filter,
  onFilterChange,
  onSetConversationHidden,
  onSetFolderHidden,
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
  onNewConversation,
  agents,
  onNewInFolder,
  onStartInFolder,
  onNewInWindow,
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
  const filtering = filter.size > 0

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
    [...filter],
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
  // Off while filtering, as while searching: the neighbors a drop reports would straddle rows the
  // filter leaves out, and only caps are accounted for there (dropNeighbors).
  useBlockReorder(listRef, {
    enabled: !searching && !filtering,
    onDrop,
    commitKey: reorderTick,
    cancelKey: JSON.stringify([mode, density, searchOpen, searching, filtering]),
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

  // Row actions menu, on any row (live or not) — the conversation's menu (conversationMenu). One shared
  // instance, opened by CLICKING the ⋮ button (anchored under it) or right-clicking (at the cursor);
  // dismissed by an outside click, Esc, or scroll.
  const [ctxMenu, setCtxMenu] = useState<{
    /** A row's conversation, or a folder header's root. */
    kind: 'row' | 'folder'
    id: string
    /** What it opens against, in viewport coords: the ⋮ button's top and bottom edges, or — for a
     *  right-click — the cursor, as a zero-height anchor. `gap` is the space kept between the two. */
    anchorTop: number
    anchorBottom: number
    gap: number
    /** `left` for a cursor (right-click) anchor, `right` for the ⋮-button anchor. */
    left?: number
    right?: number
    entries: ConversationMenuEntry[]
  } | null>(null)
  // The row's menu — the same list its tab's menu shows (conversationMenu), minus the tab's own Close.
  const menuStateFor = (id: string): { entries: ConversationMenuEntry[] } | null => {
    const entry = entryById(id)
    if (!entry) return null
    // A row that stands for no conversation keeps only what its terminal supports: Stop. One whose
    // conversation is not indexed yet — a new one before its first message — can also move, but has
    // nothing to pin, rename or show details of.
    const movable = !isUnlinkedRow(entry.pty, entry.meta)
    const place = placementFor?.(id) ?? { side: null, hasTabHere: false }
    return {
      entries: conversationMenu({
        surface: 'row',
        count: 1,
        linked: movable && !entry.meta.provisional,
        live: !!entry.pty,
        pinned: entry.pinned,
        unread: entry.liveState === 'awaiting' || entry.liveState === 'asking',
        hidden: entry.hiddenBy,
        side: movable && onOpenToSide ? place.side : null,
        newWindow: movable && !!onOpenInNewWindow,
        hasTabHere: place.hasTabHere,
        closeOthers: false,
        reopen: 0
      })
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
    openMenu({ kind: 'row', id, anchorTop: e.clientY, anchorBottom: e.clientY, gap: 0, left: e.clientX, ...s })
  }
  // A folder header's right-click: its own menu, at the cursor.
  const openFolderMenu = (e: MouseEvent, root: string): void => {
    const group = model.groups.find((g) => g.key === root)
    if (!group) return
    openMenu({
      kind: 'folder',
      id: root,
      anchorTop: e.clientY,
      anchorBottom: e.clientY,
      gap: 0,
      left: e.clientX,
      entries: folderMenu(group.folderHidden)
    })
  }
  // The ⋮ button (click): TOGGLE — close if this row's menu is already open, else open anchored under
  // the button's right edge. Read the rect synchronously — React nulls currentTarget after the handler.
  const openRowMenuFromButton = (e: MouseEvent, id: string): void => {
    if (ctxMenu && ctxMenu.kind === 'row' && ctxMenu.id === id && !closing) {
      closeMenu()
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const s = menuStateFor(id)
    if (!s) return
    openMenu({
      kind: 'row',
      id,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      gap: 4,
      right: Math.max(MENU_EDGE, window.innerWidth - rect.right),
      ...s
    })
  }
  // Place the menu once it can be measured, before it paints: below its anchor when it fits, else
  // above, clamped inside the window — the rule the tooltips follow (placeTip). A row near the foot of
  // the rail would otherwise open its menu off the bottom of the window.
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el || !ctxMenu) return
    const height = el.offsetHeight
    const { side, top } = placeTip({
      hostTop: ctxMenu.anchorTop,
      hostBottom: ctxMenu.anchorBottom,
      height,
      viewport: window.innerHeight,
      gap: ctxMenu.gap,
      edge: MENU_EDGE
    })
    el.style.top = `${side === 'bottom' ? top : top - height}px`
    if (ctxMenu.left !== undefined) {
      el.style.left = `${Math.max(MENU_EDGE, Math.min(ctxMenu.left, window.innerWidth - MENU_EDGE - el.offsetWidth))}px`
    }
  }, [ctxMenu])
  useEffect(() => {
    if (!ctxMenu) return
    // The Escape that closes the menu is consumed: App's own Escape would also clear the rail's
    // search or close Find.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeMenu()
    }
    // Scroll-to-close is scoped to the RAIL body, not a document-wide capture listener. The menu is
    // viewport-fixed but anchored to a rail row, so only a list scroll detaches it. A `document`
    // capture listener would also catch the transcript pane's scrolls — and opening a large conversation
    // re-pins to the bottom for 1–2s (window-grow + tool-result overflow settle), spamming scroll
    // events that would slam the menu shut the instant it opened. Scroll events don't bubble, so a
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
        dimmed={row.hiddenBy !== null}
        elsewhere={openElsewhere.has(row.sessionId)}
        onSelect={onSelect}
        onJump={onJump}
        onStick={onStick}
        // onOpenToSide / onOpenInNewWindow are deliberately NOT passed down: they are menu actions,
        // not click gestures. The rail still holds them for its own ⋮ and right-click menus below.
        onMarkUnread={onMarkUnread}
        onOpenMenu={openRowMenuFromButton}
        onContextMenu={openRowMenu}
      />
    )
  }

  const runMenuAction = (action: ConversationMenuAction, kind: 'row' | 'folder', id: string): void => {
    if (kind === 'folder') {
      if (action === 'hideFolder' || action === 'unhideFolder') onSetFolderHidden(id, action === 'hideFolder')
      return
    }
    if (action === 'resume') onResumeSession(id)
    else if (action === 'hide' || action === 'unhide') onSetConversationHidden(id, action === 'hide')
    else if (action === 'unhideFolder') {
      const root = model.rows.get(id)?.root
      if (root !== undefined) onSetFolderHidden(root, false)
    }
    else if (action === 'toSide') onOpenToSide?.(id)
    else if (action === 'newWindow') onOpenInNewWindow?.(id)
    else if (action === 'pin' || action === 'unpin') onTogglePin(id)
    else if (action === 'markRead' || action === 'markUnread') onToggleUnread(id)
    else if (action === 'rename') onShowInfo(id, true)
    else if (action === 'details') onShowInfo(id, false)
    else if (action === 'stop') onStopSession(id)
  }

  return (
    <aside className={`sb-rail ${density}`}>
      <SidebarHead
        scrolled={scrolled}
        mode={mode}
        onModeChange={onModeChange}
        onSetAllCollapsed={onSetAllCollapsed}
        filter={filter}
        onFilterChange={onFilterChange}
        query={query}
        onQueryChange={onQueryChange}
        searchRef={searchRef}
        searchOpen={searchOpen}
        onSearchToggle={onSearchToggle}
        onNewConversation={onNewConversation}
        onNewConversationInWindow={onNewInWindow ? () => onNewInWindow(null) : undefined}
      />

      <div
        className="sb-rail-body sb-autoscroll"
        ref={listRef}
        // The rows are one tooltip group (the folder headers' new-conversation clusters are their own).
        data-tip-group=""
        data-block={mode === 'folders' ? FOLDERS_BLOCK : undefined}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
      >
        {loading ? (
          <div className="sb-rail-empty">
            <div className="sb-rail-empty-mark" />
            <div className="label-caps">Indexing conversations…</div>
          </div>
        ) : empty ? (
          <EmptyRail
            searching={searching}
            filter={filter}
            filteredOut={model.filteredOut}
            onFilterChange={onFilterChange}
          />
        ) : (
          model.groups.map((g) => {
            const extra = revealed[g.key] ?? 0
            const more = !g.collapsed && !searching && g.withheld > 0
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
                    dimmed={g.folderHidden}
                    onToggle={onToggleFolder}
                    onContextMenu={openFolderMenu}
                    agents={agents}
                    onNew={onNewInFolder}
                    onStart={onStartInFolder}
                    onNewInWindow={onNewInWindow}
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
          ref={menuRef}
          className={`sb-ctxmenu${closing ? ' closing' : ''}`}
          // A first guess only; the layout effect above places it before paint.
          style={{ top: ctxMenu.anchorBottom + ctxMenu.gap, left: ctxMenu.left, right: ctxMenu.right }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={cancelAutoClose}
          onMouseLeave={armAutoClose}
        >
          {ctxMenu.entries.map((e, i) =>
            'separator' in e ? (
              <div key={`sep-${i}`} className="sb-ctxmenu-sep" />
            ) : (
              <button
                key={e.action}
                className={`sb-ctxmenu-item${e.danger ? ' danger' : e.action === 'resume' ? ' live' : ''}`}
                onClick={() => {
                  runMenuAction(e.action, ctxMenu.kind, ctxMenu.id)
                  closeMenu()
                }}
              >
                {menuIcon(e.action)}
                <span>{e.label}</span>
              </button>
            )
          )}
        </div>
      )}
    </aside>
  )
}
