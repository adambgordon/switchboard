import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'
import { useTabReorder } from '../lib/useTabReorder'
import type { LiveDotClass } from '../lib/rowIdentity'
import { Close } from './icons'

/** Everything the strip needs about one tab. Resolved by App, so the strip stays presentational. */
export interface TabDescriptor {
  sessionId: string
  title: string
  /** The same preview line the rail row carries for this conversation, shown under the title in the
   *  tooltip. A tab truncates far harder than a row, so without it hovering the tab tells you less
   *  than glancing at the sidebar does. Null when the conversation has no preview. */
  subtitle: string | null
  /** This is the pane's replaceable tab — the one the next ordinary open takes over. Shown italic,
   *  the way an editor marks it. */
  preview: boolean
  /** Which liveness dot to draw, or null for none. Resolved by `liveDotClass` — the SAME derivation
   *  the rail row uses, so a tab and the row for one session can never disagree about it. */
  dot: LiveDotClass | null
  /** No conversation is known to belong to this terminal, so it has no details to show. */
  unlinked: boolean
}

interface Props {
  paneIndex: number
  tabs: TabDescriptor[]
  activeIndex: number
  /** Whether this pane owns the keyboard. Only the focused pane's active tab reads fully active, so
   *  a split never shows two equally-selected tabs. */
  focused: boolean
  /** There is no split yet, and this pane has enough tabs that creating one leaves both populated. */
  canSplitRight: (sessionId: string) => boolean
  /** A split already exists, so the tab can move to the pane that is not this one. With two panes,
   *  "the other pane" is unambiguous — only the LABEL differs by side. */
  canMoveToOtherPane: boolean
  onActivate: (paneIndex: number, index: number, focusSurface?: boolean) => void
  onClose: (paneIndex: number, index: number) => void
  onCloseOthers: (paneIndex: number, index: number) => void
  onPromote: (sessionId: string, paneIndex: number) => void
  onShowInfo: (sessionId: string) => void
  /** Create the split and put this tab in the new right-hand pane. */
  onSplitRight: (sessionId: string, paneIndex: number) => void
  /** Move this tab to the pane it is not currently in. */
  onMoveToOtherPane: (sessionId: string, paneIndex: number) => void
  onOpenInNewWindow: (sessionId: string) => void
  /** A drag landed on a strip in THIS window — reorder, or move between panes. */
  onMoveTab: (from: { pane: number; index: number }, to: { pane: number; index: number }) => void
  /** A drag left this window: another window took the tab group, or it became a window of its own. */
  onTabLeftWindow: (sessionIds: string[]) => void
  /** Conversations in the current multi-selection — empty unless one is in effect. */
  selectedIds: Set<string>
  /** Drop a whole group at once (a drag carrying a multi-selection). */
  onMoveTabGroup: (
    sessionIds: string[],
    activeSessionId: string,
    to: { pane: number; index: number }
  ) => void
  /** What a gesture on this tab should act on — the group when it belongs to one, else just it. */
  onResolveTargets: (paneIndex: number, sessionId: string) => string[]
  /** ⌘-click: add or remove one tab. */
  onToggleSelect: (paneIndex: number, sessionId: string) => void
  /** ⇧-click: select the run from the anchor to here. */
  onExtendSelect: (paneIndex: number, sessionId: string) => void
}

interface ItemProps {
  tab: TabDescriptor
  active: boolean
  focused: boolean
  /** Part of the current multi-selection. */
  selected: boolean
  /** ⌘ / ⇧ handled on PRESS; returns true when it consumed the gesture, so the click is ignored. */
  onModifierPress: (e: MouseEvent) => boolean
  onActivate: () => void
  onKeyboardActivate: () => void
  onNavigate: (delta: number) => void
  onPromote: () => void
  onClose: () => void
  onContextMenu: (e: MouseEvent) => void
}

/**
 * One tab. Its own component solely so the liveness dot can hold a `useSyncedAnimation` ref — a hook
 * cannot be called inside the strip's `map`.
 */
function Tab({
  tab,
  active,
  focused,
  selected,
  onModifierPress,
  onActivate,
  onKeyboardActivate,
  onNavigate,
  onPromote,
  onClose,
  onContextMenu
}: ItemProps) {
  // Phase-lock the breathing / ripple forms to the app-wide beat, exactly as a rail row does. Without
  // this a tab's dot and its row's dot would run the same animation out of step, which reads as two
  // different things happening rather than one session doing one thing.
  const dotRef = useSyncedAnimation<HTMLSpanElement>(tab.dot)
  return (
    <div
      className={`sb-tab${active ? ' active' : ''}${active && focused ? ' focused' : ''}${tab.preview ? ' preview' : ''}${selected ? ' picked' : ''}`}
      role="tab"
      // `aria-selected` stays the ACTIVE tab — it is what the tablist role means by selected, and the
      // scroll-into-view effect keys off it. Multi-selection is a different idea, so it gets its own
      // attribute rather than overloading one whose meaning is fixed.
      aria-selected={active}
      data-picked={selected || undefined}
      data-session-id={tab.sessionId}
      tabIndex={active ? 0 : -1}
      // A tab truncates aggressively, so the full title lives in the shared tooltip layer — never a
      // native `title`, which lags and resets on the slightest pointer move. `data-tip-sub` adds the
      // preview line beneath it, giving the hover the same content as a rail row.
      data-tip={tab.title}
      {...(tab.subtitle ? { 'data-tip-sub': tab.subtitle } : {})}
      // Selection is decided on PRESS, not on click. A press is the moment the user commits to a tab,
      // it is what every list of this kind responds to, and it does not depend on a `click` arriving
      // afterwards — which is the fragile part, since a press begins a drag, moves focus, and can
      // re-render the strip before any click is dispatched. `preventDefault` stops the press from also
      // starting a text selection across the strip.
      onPointerDown={(e) => {
        if (onModifierPress(e)) e.preventDefault()
      }}
      // The plain case only: a modified click was already handled above, and acting again here would
      // undo the selection that press just made.
      onClick={(e) => {
        if (!e.metaKey && !e.shiftKey) onActivate()
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onKeyboardActivate()
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          onNavigate(e.key === 'ArrowRight' ? 1 : -1)
        }
      }}
      // A ⌘- or ⇧-click must not also start a drag-reorder; the hook checks the same modifiers.
      // Double-click is the editor gesture for "keep this one". The two ordinary clicks that precede
      // it only activate an already-open tab, which is idempotent, so no dedupe is needed here —
      // unlike the same gesture on a rail row, which records history stops.
      onDoubleClick={onPromote}
      // Middle-click closes, as in a browser. Nothing else in the app claims button 1.
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose()
        }
      }}
      onContextMenu={onContextMenu}
    >
      <span className="sb-tab-title truncate">{tab.title}</span>
      {/* The dot's slot exists ONLY when there is a dot. It used to be reserved unconditionally, so
          the close button always had somewhere to appear without resizing the tab — but that left
          every not-live tab carrying ~30px of permanent dead space to hold a button that is not
          there. The button is positioned against the tab's own right edge instead (see CSS): over the
          gutter when one exists, over the title's tail when it does not. Nothing reflows either way,
          and the tail it covers is the ellipsis on any title long enough to need one. */}
      {tab.dot && (
        <span className="sb-tab-gutter">
          <span ref={dotRef} className={`sb-dot ${tab.dot}`} aria-label="live" role="img" />
        </span>
      )}
      <button
        className="sb-tab-close"
        // The tooltip is generic while the accessible name is specific: the tip appears under the
        // pointer, where which tab is meant is already obvious, whereas a screen reader announces the
        // button with no such context.
        data-tip="Close tab"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <Close size={12} />
      </button>
    </div>
  )
}

/**
 * The tab strip above a pane's header.
 *
 * The strip is chrome, so it sits on `--paper-sunken` like the title bar and the rail, and the active
 * tab is lifted onto `--paper-pane` — the surface of the content directly beneath it — so the two
 * read as one continuous sheet. Neither state uses an accent: cobalt means a session is alive and red
 * means destructive, and "this tab is selected" is neither. The only cobalt here is the shared
 * `.sb-dot`, which means what it means everywhere else.
 *
 * Tabs WRAP into rows rather than scrolling sideways. A horizontal strip hides its overflow behind an
 * edge, so the tab you want is both invisible and in an unknown direction; wrapped rows keep every
 * tab addressable at a glance, which is the whole reason to have tabs instead of just the rail. Rows
 * are capped (`--tab-rows`) so a pane full of tabs cannot eat the content beneath it — past the cap
 * the strip scrolls vertically, and the active tab is kept in view.
 *
 * Deliberately NOT copied from the editors this borrows from: moving the active tab's row to the
 * bottom. It buys a seam between the tab and the pane, and costs having tabs rearrange themselves
 * under the pointer — against the stable-key ordering rule the rail already holds to.
 *
 * Right-click pops a NATIVE menu rather than an in-app one. Same reasoning as the transcript's link
 * and code menus: macOS already draws it correctly in both themes, flips it near a screen edge, and
 * dismisses it properly — and an OS menu is not anchored to a DOM node, so the strip scrolling out
 * from under it cannot close it.
 */
export default function TabStrip({
  paneIndex,
  tabs,
  activeIndex,
  focused,
  canSplitRight,
  canMoveToOtherPane,
  onActivate,
  onClose,
  onCloseOthers,
  onPromote,
  onShowInfo,
  onSplitRight,
  onMoveToOtherPane,
  onOpenInNewWindow,
  onMoveTab,
  onTabLeftWindow,
  selectedIds,
  onMoveTabGroup,
  onResolveTargets,
  onToggleSelect,
  onExtendSelect
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null)
  // Dragging: reorder here, move to the other pane, move to another window, or off into a new one.
  // The strip's own tab order is derived rather than passed — it is already in `tabs`.
  useTabReorder(stripRef, {
    paneIndex,
    order: tabs.map((t) => t.sessionId),
    // Any tab can be dragged, including a pane's only one: it cannot be reordered, but moving it to
    // the other pane or another window is still meaningful — this pane just ends up empty.
    enabled: tabs.length > 0,
    onMove: onMoveTab,
    onMoveGroup: onMoveTabGroup,
    targetsFor: (sessionId) => onResolveTargets(paneIndex, sessionId),
    onLeaveWindow: onTabLeftWindow
  })
  // Past the row cap the strip becomes a vertical scroller, and it carries the same hide-at-rest
  // behavior as every other scroller in the app.
  useAutoHideScrollbar(stripRef)

  const overflowGeometryKey = JSON.stringify(
    tabs.map((tab) => [tab.sessionId, tab.title, tab.preview, !!tab.dot])
  )
  const keepActiveVisible = (): void => {
    const active = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  // Chromium's custom vertical scrollbar consumes an inline lane even when there is nothing to
  // scroll. Mark real overflow before paint so CSS can collapse that idle lane without making tabs
  // jump when a working scrollbar is actually needed. ResizeObserver covers pane resizing and wrap
  // changes; the key covers only tab properties that can alter geometry. Activation is deliberately
  // absent, so selecting a tab never forces a synchronous layout read or rebuilds the observer.
  useLayoutEffect(() => {
    const el = stripRef.current
    if (!el) return
    const update = (): void => {
      el.classList.toggle('is-overflowing', el.scrollHeight - el.clientHeight > 1)
      keepActiveVisible()
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [overflowGeometryKey])

  // Keep the active tab visible when the rows overflow the cap — otherwise ⌘1-9, ⌥⌘←/→, and opening
  // a conversation from the rail can all select a tab in a row that is scrolled out of sight, leaving
  // the strip looking as though nothing happened. Queried from the DOM rather than threaded through a
  // ref: the selected tab is already marked for assistive technology, so there is one source for it.
  // `nearest` on both axes so this scrolls the minimum, and never the pane behind it.
  useEffect(() => {
    keepActiveVisible()
  }, [activeIndex, tabs.length])

  const navigateFrom = (index: number, delta: number): void => {
    if (tabs.length === 0) return
    const next = (index + delta + tabs.length) % tabs.length
    onActivate(paneIndex, next, false)
    stripRef.current?.querySelectorAll<HTMLElement>('.sb-tab')[next]?.focus()
  }

  const contextMenu = async (e: MouseEvent, index: number): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const tab = tabs[index]
    if (!tab) return
    // How many tabs the chosen command will act on, so the menu can say so rather than quietly
    // closing five conversations under a label that reads like it means one.
    const groupSize = selectedIds.has(tab.sessionId) && selectedIds.size > 1 ? selectedIds.size : 1
    const choice = await window.api.tabContextMenu({
      count: groupSize,
      closeOthers: tabs.length > 1,
      // An unlinked terminal has no conversation, so there are no details to show and nothing to
      // reopen elsewhere by id — hide both rather than offer controls that silently do nothing.
      details: !tab.unlinked,
      splitRight: canSplitRight(tab.sessionId),
      // Same action either way; the side this pane is on decides which direction to name it.
      moveRight: canMoveToOtherPane && paneIndex === 0,
      moveLeft: canMoveToOtherPane && paneIndex === 1,
      newWindow: !tab.unlinked
    })
    if (choice === 'close') onClose(paneIndex, index)
    else if (choice === 'closeOthers') onCloseOthers(paneIndex, index)
    else if (choice === 'details') onShowInfo(tab.sessionId)
    else if (choice === 'splitRight') onSplitRight(tab.sessionId, paneIndex)
    else if (choice === 'moveRight' || choice === 'moveLeft') {
      onMoveToOtherPane(tab.sessionId, paneIndex)
    } else if (choice === 'newWindow') onOpenInNewWindow(tab.sessionId)
  }

  return (
    <div
      className="sb-tabstrip sb-autoscroll"
      ref={stripRef}
      role="tablist"
      // Read by the drag hook when it hit-tests every strip in the window: a drop has to resolve to a
      // pane, and the DOM is where both strips are visible to each other.
      data-pane={paneIndex}
    >
      {tabs.map((tab, i) => (
        <Tab
          key={tab.sessionId}
          tab={tab}
          active={i === activeIndex}
          focused={focused}
          selected={selectedIds.has(tab.sessionId)}
          // ⇧ is tested before ⌘ so ⇧⌘ extends rather than toggling — extending is the more
          // destructive of the two (it replaces the run), so it should be the one that wins outright
          // rather than being reachable only by accident.
          onModifierPress={(e) => {
            if (e.shiftKey) {
              onExtendSelect(paneIndex, tab.sessionId)
              return true
            }
            if (e.metaKey) {
              onToggleSelect(paneIndex, tab.sessionId)
              return true
            }
            return false
          }}
          onActivate={() => onActivate(paneIndex, i)}
          onKeyboardActivate={() => onActivate(paneIndex, i, false)}
          onNavigate={(delta) => navigateFrom(i, delta)}
          onPromote={() => onPromote(tab.sessionId, paneIndex)}
          onClose={() => onClose(paneIndex, i)}
          onContextMenu={(e) => void contextMenu(e, i)}
        />
      ))}
    </div>
  )
}
