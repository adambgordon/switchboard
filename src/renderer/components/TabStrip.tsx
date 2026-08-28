import { useRef, type MouseEvent } from 'react'
import type { AgentKind } from '@shared/types'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'
import { Close } from './icons'
import AgentLogo from './AgentLogo'

/** Everything the strip needs about one tab. Resolved by App, so the strip stays presentational. */
export interface TabDescriptor {
  sessionId: string
  title: string
  agent: AgentKind
  /** Replaced in place by the next ordinary open — shown italic, the way an editor marks one. */
  preview: boolean
  /** A live process is attached. Carries a STATIC cobalt dot: the breathing and ripple forms belong
   *  to the left-pane rows only, so a strip full of tabs cannot turn into a light show. */
  live: boolean
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
  onActivate: (paneIndex: number, index: number) => void
  onClose: (paneIndex: number, index: number) => void
  onCloseOthers: (paneIndex: number, index: number) => void
  onPromote: (sessionId: string, paneIndex: number) => void
  onShowInfo: (sessionId: string) => void
}

/**
 * The tab strip above a pane's header.
 *
 * The strip is chrome, so it sits on `--paper-sunken` like the title bar and the rail, and the active
 * tab is lifted onto `--paper-pane` — the surface of the content directly beneath it — so the two
 * read as one continuous sheet. Neither state uses an accent: cobalt means a session is alive and red
 * means destructive, and "this tab is selected" is neither.
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
  onActivate,
  onClose,
  onCloseOthers,
  onPromote,
  onShowInfo
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null)
  // Tabs shrink before they scroll, but a strip full of them still overflows — and a horizontal bar
  // carries the same hide-at-rest behavior as every other scroller in the app.
  useAutoHideScrollbar(stripRef)

  const contextMenu = async (e: MouseEvent, index: number): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const tab = tabs[index]
    if (!tab) return
    const choice = await window.api.tabContextMenu({
      closeOthers: tabs.length > 1,
      // An unlinked terminal has no conversation, so there are no details to show — hide the item
      // rather than offer one that silently does nothing.
      details: !tab.unlinked
    })
    if (choice === 'close') onClose(paneIndex, index)
    else if (choice === 'closeOthers') onCloseOthers(paneIndex, index)
    else if (choice === 'details') onShowInfo(tab.sessionId)
  }

  return (
    <div className="sb-tabstrip sb-autoscroll" ref={stripRef} role="tablist">
      {tabs.map((tab, i) => {
        const active = i === activeIndex
        return (
          <div
            key={tab.sessionId}
            className={`sb-tab${active ? ' active' : ''}${active && focused ? ' focused' : ''}${tab.preview ? ' preview' : ''}`}
            role="tab"
            aria-selected={active}
            tabIndex={-1}
            // A tab truncates aggressively, so the full title lives in the shared tooltip layer —
            // never a native `title`, which lags and resets on the slightest pointer move.
            data-tip={tab.title}
            onClick={() => onActivate(paneIndex, i)}
            // Double-click is the editor gesture for "keep this one". The two ordinary clicks that
            // precede it only activate an already-open tab, which is idempotent, so no dedupe is
            // needed here — unlike the same gesture on a rail row, which records history stops.
            onDoubleClick={() => onPromote(tab.sessionId, paneIndex)}
            // Middle-click closes, as in a browser. Nothing else in the app claims button 1.
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(paneIndex, i)
              }
            }}
            onContextMenu={(e) => void contextMenu(e, i)}
          >
            <AgentLogo agent={tab.agent} size={11} />
            <span className="sb-tab-title truncate">{tab.title}</span>
            {/* Fixed-width trailing slot: a live tab shows a static cobalt dot at rest and the close
                button on hover, mirroring how a rail row's gutter swaps its dot for the ⋮ button. The
                width is reserved either way so a tab never changes size under the pointer. */}
            <span className="sb-tab-gutter">
              {tab.live && <span className="sb-dot" aria-label="live" role="img" />}
              <button
                className="sb-tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(paneIndex, i)
                }}
              >
                <Close size={12} />
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}
