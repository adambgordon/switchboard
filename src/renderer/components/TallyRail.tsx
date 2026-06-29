import { Fragment, useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import type { AgentKind, ConversationMeta, LiveState, PtyState } from '@shared/types'
import type { SectionKey } from '../lib/useLayout'
import { useRailFlip } from '../lib/useRailFlip'
import { useRowReorder } from '../lib/useRowReorder'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'
import { useOverflowFade } from '../lib/useOverflowFade'
import ConversationRow from './ConversationRow'
import NewConversationMenu from './NewConversationMenu'
import { Chevron, Close, Plus, Search, Pin, Info, Stop, Play } from './icons'

/** One row in the pane: a conversation that may be live, pinned, both, or neither. */
export interface RailEntry {
  sessionId: string
  /** The live process, when this conversation is currently running. */
  pty: PtyState | null
  /** Display metadata — indexed, or synthesized from the live process if not yet on disk. */
  meta: ConversationMeta
  pinned: boolean
  /** Resolved liveness (working / asking / awaiting / quiet); null when not live. */
  liveState: LiveState | null
}

export interface RailSection {
  key: SectionKey
  label: string
  /** 'card' = raised cards (Pinned/Live); 'row' = flat rows (Recent). */
  variant: 'card' | 'row'
  entries: RailEntry[]
  /** When set, the section shows at most this many rows until expanded via "Show more". */
  cap?: number
}

/**
 * The rows actually shown for a section — the single source of truth for visibility,
 * shared by the renderer below and by App's keyboard-nav ordering so the two never drift.
 * Search expands everything (no collapse, no cap); otherwise a collapsed section shows
 * nothing and a capped section (Recent) is sliced until the user reveals the rest.
 */
export function visibleEntries(
  section: RailSection,
  opts: { collapsed: boolean; expanded: boolean; searching: boolean }
): RailEntry[] {
  if (opts.searching) return section.entries
  if (opts.collapsed) return []
  return section.cap != null && !opts.expanded ? section.entries.slice(0, section.cap) : section.entries
}

interface Props {
  /** Ordered, non-empty sections (Pinned / Live / Recent), built in App. */
  sections: RailSection[]
  /** Live tally over ALL sessions (not the search-filtered set) — drives the count + status line. */
  live: { count: number; working: number; asking: number; unread: number; idle: number }
  /** True during the initial conversation index, before sections are populated. */
  loading: boolean
  selectedSessionId: string | null
  onJump: (sessionId: string) => void
  onSelect: (sessionId: string) => void
  onTogglePin: (sessionId: string) => void
  // search — lives on the status line; opening it replaces the working/idle sub-label
  query: string
  onQueryChange: (q: string) => void
  searchRef: RefObject<HTMLInputElement>
  searchOpen: boolean
  onSearchToggle: () => void
  /** True when a query is active — sections render expanded and uncapped. */
  searching: boolean
  // collapse + capped-section reveal
  collapsedSections: Record<SectionKey, boolean>
  onToggleSection: (key: SectionKey) => void
  /** Section keys the user has revealed past their cap (the Recent "Show more"). */
  expandedSections: Set<string>
  onShowMore: (key: SectionKey) => void
  // new conversation — the "+" above search opens the folder menu (mirrors ⌘N)
  menuOpen: boolean
  onMenuToggle: () => void
  /** Right-click the "+" → open the chooser even when a default folder is set (the escape hatch). */
  onNewContextMenu: () => void
  onMenuClose: () => void
  recentDirs: string[]
  /** The default folder ('' = none) — pinned + preselected at the top of the menu's directory list. */
  menuDefaultDir: string
  /** Agents to offer in the menu's segmented control; collapses to a single agent when <2. */
  menuAgents: AgentKind[]
  /** The agent the menu shows selected (sticky last-picked / resolved default). */
  menuAgent: AgentKind
  /** Report the agent the user picks in the menu's segment, so the choice sticks across opens. */
  onMenuAgentChange: (agent: AgentKind) => void
  /** Start a new conversation in `cwd` with `agent` (a recent-dir click, or the resolved default). */
  onChoose: (cwd: string, agent: AgentKind) => void
  /** Pick a folder via the native dialog, then start a new `agent` conversation there. */
  onPickOther: (agent: AgentKind) => void
  /** True when a default folder is set + enabled — the "+" / ⌘N spawn straight into it. */
  defaultDirActive: boolean
  /** Basename of the default folder, surfaced in the "+" tooltip when active. */
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
  /** Reorder the pinned list — the drag-to-reorder commit (indices into `pinnedOrder`). */
  onReorderPins: (from: number, to: number) => void
  /** Current pinned order (display order, top-first) — resolves drag from/to indices. */
  pinnedOrder: string[]
  /** Reorder the live list — the drag-to-reorder commit (indices into `liveOrder`). */
  onReorderLive: (from: number, to: number) => void
  /** Current live order (display order, top-first) — resolves drag from/to indices. */
  liveOrder: string[]
  /** Bumped on each drag-reorder commit; folded into controlSig so that commit settles instantly. */
  reorderTick: number
}

/**
 * The unified conversation pane (the former Tally Rail, now the single left column).
 * A status head counting live sessions — with an inline search that replaces the
 * working/idle sub-label — then three collapsible, mutually-exclusive sections:
 * Pinned, Live, and Recent (a flat history capped with a "Show more" reveal).
 * Liveness is the cobalt dot, never a section.
 */
export default function TallyRail({
  sections,
  live,
  loading,
  selectedSessionId,
  onJump,
  onSelect,
  onTogglePin,
  query,
  onQueryChange,
  searchRef,
  searchOpen,
  onSearchToggle,
  searching,
  collapsedSections,
  onToggleSection,
  expandedSections,
  onShowMore,
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
  onReorderPins,
  pinnedOrder,
  onReorderLive,
  liveOrder,
  reorderTick
}: Props) {
  const { count, working, asking, unread, idle } = live
  const empty = sections.length === 0

  // The status sub-label, shown when something is live (the search field replaces it).
  // working = mid-turn · asking = blocked on your reply · unread = finished, not yet seen ·
  // idle = finished and seen.
  let subLabel = ''
  if (count > 0) {
    const parts: string[] = []
    if (working > 0) parts.push(`${working} working`)
    if (asking > 0) parts.push(`${asking} waiting on you`)
    if (unread > 0) parts.push(`${unread} unread`)
    if (idle > 0) parts.push(`${idle} idle`)
    subLabel = parts.length > 0 ? parts.join(' · ') : 'all idle'
  }

  // Obsidian-style scrollbar: the thumb shows only while scrolling (+ a beat after), never at rest.
  const listRef = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(listRef)
  // Fade the last rows when the list overflows and isn't scrolled to the bottom (more below).
  useOverflowFade(listRef)

  // Divider under the head: shown only once the list is scrolled off the top (none at the very top),
  // so the head reads as a fixed band separated from the content it sits above. Driven off the body's
  // scrollTop — a boolean, so setState is a no-op re-render until it actually flips (no per-event cost).
  const [scrolled, setScrolled] = useState(false)

  // Each section's visible rows, computed once via visibleEntries (the single source of truth for
  // visibility) and reused by both the FLIP signature below and the render, so the two never diverge.
  const rendered = sections.map((section) => {
    const collapsed = !searching && collapsedSections[section.key]
    const expanded = expandedSections.has(section.key)
    return { section, collapsed, shown: visibleEntries(section, { collapsed, expanded, searching }) }
  })
  // Glide rows that change position (pinned / resumed / unpinned) to their new section instead of
  // teleporting. orderSig (the visible ids, in order) drives a slide; controlSig (search query +
  // collapse + show-more) marks a layout change we deliberately keep instant — see useRailFlip.
  const orderSig = rendered.flatMap((r) => r.shown.map((e) => e.sessionId)).join('|')
  const controlSig = JSON.stringify([query, [...expandedSections].sort(), collapsedSections, reorderTick])
  useRailFlip(listRef, orderSig, controlSig)

  // Re-evaluate the head divider when the visible content changes: collapsing a section or running a
  // search can shrink the list back within the viewport (scrollTop snaps to 0) WITHOUT firing a scroll
  // event, which would otherwise leave the divider stuck on.
  useEffect(() => {
    const el = listRef.current
    if (el) setScrolled(el.scrollTop > 0)
  }, [orderSig, controlSig])

  // Look up a rendered entry by id — used by the right-click menu.
  const entryById = (id: string): RailEntry | undefined =>
    sections.flatMap((s) => s.entries).find((en) => en.sessionId === id)

  // Click + drag a row to reorder its section — Pinned and Live each get their own instance on the
  // same container, partitioned by selector (a pinned-live row carries `.pinned`, so the pinned
  // instance owns it; pure-live rows match `.live:not(.pinned)`). Disabled during search (sections
  // are filtered then); commits only on drop, so useRailFlip stays dormant during the drag and glides
  // the settle afterward.
  useRowReorder(listRef, {
    enabled: !searching,
    order: pinnedOrder,
    onReorder: onReorderPins,
    selector: '.sb-row.pinned[data-session]'
  })
  useRowReorder(listRef, {
    enabled: !searching,
    order: liveOrder,
    onReorder: onReorderLive,
    selector: '.sb-row.live:not(.pinned)[data-session]'
  })

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
  } | null>(null)
  const menuStateFor = (id: string): { live: boolean; unread: boolean; pinned: boolean } | null => {
    const entry = entryById(id)
    if (!entry) return null
    return {
      live: !!entry.pty,
      unread: entry.liveState === 'awaiting' || entry.liveState === 'asking',
      pinned: entry.pinned
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

  return (
    <aside className="sb-rail">
      <div className={`sb-rail-head${scrolled ? ' scrolled' : ''}`}>
        <div className="sb-rail-head-top">
          <div className="sb-rail-count-wrap">
            <span className={`sb-rail-count${count > 0 ? ' on' : ''}`}>{count}</span>
            <span className="sb-rail-count-label label-caps">{count === 1 ? 'live session' : 'live sessions'}</span>
          </div>
          <div className="sb-newwrap sb-rail-newwrap">
            <button
              className={`sb-rail-new-btn${menuOpen ? ' open' : ''}`}
              onClick={onMenuToggle}
              onContextMenu={(e) => {
                e.preventDefault()
                onNewContextMenu()
              }}
              data-tip={
                defaultDirActive
                  ? `New conversation in ${defaultDirLabel} (⌘N) · right-click to choose`
                  : 'New conversation (⌘N)'
              }
              aria-label="New conversation"
            >
              <Plus size={16} />
            </button>
            <NewConversationMenu
              open={menuOpen}
              recentDirs={recentDirs}
              defaultDir={menuDefaultDir}
              agents={menuAgents}
              initialAgent={menuAgent}
              onAgentChange={onMenuAgentChange}
              onChoose={onChoose}
              onPickOther={onPickOther}
              onClose={onMenuClose}
            />
          </div>
        </div>
        <div className="sb-rail-sub-row">
          {searchOpen ? (
            <div className="sb-rail-search-box">
              <input
                ref={searchRef}
                className="sb-rail-search-input"
                placeholder="Search conversations"
                value={query}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(e) => onQueryChange(e.target.value)}
              />
              <button
                className="sb-rail-search-clear"
                onClick={onSearchToggle}
                data-tip="Close search"
                aria-label="Close search"
              >
                <Close size={14} />
              </button>
            </div>
          ) : (
            <>
              <div className="sb-rail-sub mono">{subLabel}</div>
              <button
                className="sb-rail-search-btn"
                onClick={onSearchToggle}
                data-tip="Search all conversations (⌘F)"
                aria-label="Search all conversations"
              >
                <Search size={15} />
              </button>
            </>
          )}
        </div>
      </div>

      <div
        className="sb-rail-body sb-autoscroll"
        ref={listRef}
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
          rendered.map(({ section, collapsed, shown }) => {
            const hiddenByCap = section.entries.length - shown.length
            return (
              <Fragment key={section.key}>
                <div className="sb-rail-section">
                  <button
                    className="sb-rail-section-head"
                    onClick={() => onToggleSection(section.key)}
                    aria-expanded={!collapsed}
                  >
                    <Chevron size={11} className={`sb-rail-chevron${collapsed ? ' collapsed' : ''}`} />
                    <span className="sb-rail-section-label label-caps">{section.label}</span>
                    <span className="sb-rail-section-rule" />
                    <span className="sb-rail-section-count mono">{section.entries.length}</span>
                  </button>
                </div>
                {shown.map((entry) => (
                  <ConversationRow
                    key={entry.sessionId}
                    meta={entry.meta}
                    selected={entry.sessionId === selectedSessionId}
                    live={entry.pty}
                    liveState={entry.liveState}
                    pinned={entry.pinned}
                    showCwd
                    card={section.variant === 'card' && !!entry.pty}
                    onSelect={onSelect}
                    onJump={onJump}
                    onMarkUnread={onMarkUnread}
                    onOpenMenu={openRowMenuFromButton}
                    onContextMenu={openRowMenu}
                  />
                ))}
                {!collapsed && !searching && hiddenByCap > 0 && (
                  <button className="sb-rail-more label-caps" onClick={() => onShowMore(section.key)}>
                    Show {hiddenByCap} more
                  </button>
                )}
              </Fragment>
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
          {ctxMenu.live && (
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
          {/* The session action sits at the bottom behind a divider — **Stop** (live) or **Resume**
              (not-live) — so the two always occupy the same slot. Separated from the benign items above. */}
          <div className="sb-ctxmenu-sep" />
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
