import { useEffect, useRef, type MouseEvent } from 'react'
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
  /** Whether sending a tab from THIS pane to the other one would change anything — false in the
   *  right-hand pane, and false when the pane holds a single tab (moving it would only empty this
   *  pane, which the layout then collapses, so the split never happens). */
  canSplitRight: boolean
  onActivate: (paneIndex: number, index: number) => void
  onClose: (paneIndex: number, index: number) => void
  onCloseOthers: (paneIndex: number, index: number) => void
  onPromote: (sessionId: string, paneIndex: number) => void
  onShowInfo: (sessionId: string) => void
  /** Move the tab to the other pane, creating the split when there is none. */
  onSplitRight: (sessionId: string, paneIndex: number) => void
  onOpenInNewWindow: (sessionId: string) => void
  /** A drag landed on a strip in THIS window — reorder, or move between panes. */
  onMoveTab: (from: { pane: number; index: number }, to: { pane: number; index: number }) => void
  /** A drag left this window: another window took the tab, or it became a window of its own. */
  onTabLeftWindow: (sessionId: string) => void
}

interface ItemProps {
  tab: TabDescriptor
  active: boolean
  focused: boolean
  onActivate: () => void
  onPromote: () => void
  onClose: () => void
  onContextMenu: (e: MouseEvent) => void
}

/**
 * One tab. Its own component solely so the liveness dot can hold a `useSyncedAnimation` ref — a hook
 * cannot be called inside the strip's `map`.
 */
function Tab({ tab, active, focused, onActivate, onPromote, onClose, onContextMenu }: ItemProps) {
  // Phase-lock the breathing / ripple forms to the app-wide beat, exactly as a rail row does. Without
  // this a tab's dot and its row's dot would run the same animation out of step, which reads as two
  // different things happening rather than one session doing one thing.
  const dotRef = useSyncedAnimation<HTMLSpanElement>(tab.dot)
  return (
    <div
      className={`sb-tab${active ? ' active' : ''}${active && focused ? ' focused' : ''}${tab.preview ? ' preview' : ''}`}
      role="tab"
      aria-selected={active}
      tabIndex={-1}
      // A tab truncates aggressively, so the full title lives in the shared tooltip layer — never a
      // native `title`, which lags and resets on the slightest pointer move. `data-tip-sub` adds the
      // preview line beneath it, giving the hover the same content as a rail row.
      data-tip={tab.title}
      {...(tab.subtitle ? { 'data-tip-sub': tab.subtitle } : {})}
      onClick={onActivate}
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
      {/* Fixed-width trailing slot: a live tab shows its liveness dot at rest and the close button on
          hover, mirroring how a rail row's gutter swaps its dot for the ⋮ button. The width is
          reserved either way so a tab never changes size under the pointer. */}
      <span className="sb-tab-gutter">
        {tab.dot && <span ref={dotRef} className={`sb-dot ${tab.dot}`} aria-label="live" role="img" />}
        <button
          className="sb-tab-close"
          aria-label={`Close ${tab.title}`}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <Close size={12} />
        </button>
      </span>
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
  onActivate,
  onClose,
  onCloseOthers,
  onPromote,
  onShowInfo,
  onSplitRight,
  onOpenInNewWindow,
  onMoveTab,
  onTabLeftWindow
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
    onLeaveWindow: onTabLeftWindow
  })
  // Past the row cap the strip becomes a vertical scroller, and it carries the same hide-at-rest
  // behavior as every other scroller in the app.
  useAutoHideScrollbar(stripRef)

  // Keep the active tab visible when the rows overflow the cap — otherwise ⌘1-9, ⌥⌘←/→, and opening
  // a conversation from the rail can all select a tab in a row that is scrolled out of sight, leaving
  // the strip looking as though nothing happened. Queried from the DOM rather than threaded through a
  // ref: the selected tab is already marked for assistive technology, so there is one source for it.
  // `nearest` on both axes so this scrolls the minimum, and never the pane behind it.
  useEffect(() => {
    const el = stripRef.current?.querySelector('[aria-selected="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeIndex, tabs.length])

  const contextMenu = async (e: MouseEvent, index: number): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const tab = tabs[index]
    if (!tab) return
    const choice = await window.api.tabContextMenu({
      closeOthers: tabs.length > 1,
      // An unlinked terminal has no conversation, so there are no details to show and nothing to
      // reopen elsewhere by id — hide both rather than offer controls that silently do nothing.
      details: !tab.unlinked,
      splitRight: canSplitRight,
      newWindow: !tab.unlinked
    })
    if (choice === 'close') onClose(paneIndex, index)
    else if (choice === 'closeOthers') onCloseOthers(paneIndex, index)
    else if (choice === 'details') onShowInfo(tab.sessionId)
    else if (choice === 'splitRight') onSplitRight(tab.sessionId, paneIndex)
    else if (choice === 'newWindow') onOpenInNewWindow(tab.sessionId)
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
          onActivate={() => onActivate(paneIndex, i)}
          onPromote={() => onPromote(tab.sessionId, paneIndex)}
          onClose={() => onClose(paneIndex, i)}
          onContextMenu={(e) => void contextMenu(e, i)}
        />
      ))}
    </div>
  )
}
