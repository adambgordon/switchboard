import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentKind } from '@shared/types'
import { bellState, type AttentionItem } from '../lib/attention'
import { META_SEP, relTime } from '../lib/format'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'
import AgentLogo from './AgentLogo'
import MetaText from './MetaText'
import { Bell, Check, CheckCircle } from './icons'

/** One conversation in the panel, already in triage order. */
export interface AttentionEntry extends AttentionItem {
  title: string
  agent: AgentKind
  folder: string
}

interface Props {
  entries: AttentionEntry[]
  /** Open it exactly as a rail click does — which also marks it read. */
  onOpen: (sessionId: string) => void
  onMarkRead: (sessionId: string) => void
  onMarkAllRead: () => void
}

// Long enough that crossing the bell on the way to the theme toggle or the gear opens nothing; short
// enough that resting on it feels immediate. The close grace covers a pointer cutting the corner
// between the bell and the panel, which a zero delay would treat as leaving.
const OPEN_DELAY = 150
const CLOSE_DELAY = 300

/**
 * The title-bar bell. Its dot summarizes everything that needs you, drawn exactly like a row's —
 * rippling for a question, solid for an unread turn — and hovering it lists them. App-wide, and in the
 * title bar rather than the rail so that a window with its rail hidden still says so.
 *
 * Opened by hover. A click opens it at once rather than waiting out the hover delay — and does nothing
 * else, since it is the same list either way.
 */
export default function AttentionBell({ entries, onOpen, onMarkRead, onMarkAllRead }: Props) {
  const bellRef = useRef<HTMLButtonElement>(null)
  const dot = bellState(entries.map((e) => e.state))
  const dotRef = useSyncedAnimation<HTMLSpanElement>(dot)
  // `closing` keeps the panel mounted for its fade-out, like the rail's menu.
  const [panel, setPanel] = useState<'closed' | 'open' | 'closing'>('closed')
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const clearTimers = (): void => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    openTimer.current = closeTimer.current = null
  }
  useEffect(() => clearTimers, [])

  const open = (): void => {
    const r = bellRef.current?.getBoundingClientRect()
    if (r) setAnchor({ top: r.bottom + 4, right: window.innerWidth - r.right })
    setPanel('open')
  }
  const close = (): void => {
    clearTimers()
    setPanel((p) => (p === 'open' ? 'closing' : p))
  }
  const enter = (): void => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
    if (panel === 'open' || openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      open()
    }, OPEN_DELAY)
  }
  const leave = (): void => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    openTimer.current = null
    if (panel !== 'open') return
    closeTimer.current = window.setTimeout(close, CLOSE_DELAY)
  }

  // Esc closes it — and only it: captured ahead of the app's own Esc handling, which would otherwise
  // also close whatever else Esc closes.
  useLayoutEffect(() => {
    if (panel !== 'open') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [panel])

  const count = entries.length
  const asking = entries.filter((e) => e.state === 'asking').length
  // Each kind named only when there is some: "2 awaiting input", "3 unread", or both.
  const kinds = [
    asking > 0 && `${asking} awaiting input`,
    count - asking > 0 && `${count - asking} unread`
  ].filter(Boolean)
  const summary = kinds.join(META_SEP)
  // The spoken label joins with a comma; the separator is for the eye.
  const label = count === 0 ? 'All caught up' : kinds.join(', ')
  return (
    <>
      <button
        ref={bellRef}
        className={`sb-panel-toggle sb-bell${panel === 'open' ? ' active' : ''}`}
        onClick={() => {
          clearTimers()
          if (panel !== 'open') open()
        }}
        onPointerEnter={enter}
        onPointerLeave={leave}
        aria-label={count === 0 ? label : `Needs you: ${label}`}
        aria-expanded={panel === 'open'}
      >
        <Bell size={16} filled={count > 0} />
        {dot && <span ref={dotRef} className={`sb-dot ${dot} sb-bell-dot`} aria-hidden="true" />}
      </button>
      {panel !== 'closed' && anchor && (
        <div
          className={`sb-ctxmenu sb-bell-panel${panel === 'closing' ? ' closing' : ''}`}
          style={{ top: anchor.top, right: anchor.right }}
          onPointerEnter={enter}
          onPointerLeave={leave}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget && panel === 'closing') setPanel('closed')
          }}
        >
          {count === 0 ? (
            // Nothing to do here, and it looks it: greyed, and no control to press.
            <div className="sb-bell-empty">
              <CheckCircle size={20} />
              <span>All caught up</span>
            </div>
          ) : (
            <div className="sb-bell-head">
              <span className="sb-bell-title"><MetaText text={summary} /></span>
              <button className="sb-bell-allread" onClick={onMarkAllRead}>
                Mark all read
              </button>
            </div>
          )}
          {count > 0 && (
            <div className="sb-bell-list">
              {entries.map((e) => (
                <BellItem
                  key={e.sessionId}
                  entry={e}
                  onOpen={() => {
                    close()
                    onOpen(e.sessionId)
                  }}
                  onMarkRead={() => onMarkRead(e.sessionId)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  )
}

function BellItem({ entry, onOpen, onMarkRead }: { entry: AttentionEntry; onOpen: () => void; onMarkRead: () => void }) {
  const dotRef = useSyncedAnimation<HTMLSpanElement>(entry.state)
  const ago = relTime(entry.at)
  const when = `${entry.state === 'asking' ? 'asked' : 'finished'} ${ago === 'now' ? 'just now' : `${ago} ago`}`
  return (
    <div className="sb-bell-item">
      <button className="sb-bell-open" onClick={onOpen}>
        <AgentLogo agent={entry.agent} />
        <span className="sb-bell-text">
          <span className="sb-bell-name">{entry.title}</span>
          <span className="sb-bell-meta"><MetaText text={entry.folder ? `${entry.folder}${META_SEP}${when}` : when} /></span>
        </span>
      </button>
      {/* The rail's gutter: the dot at rest, swapped for its one action on hover, as a row swaps its
          dot for ⋮. */}
      <span className="sb-bell-gutter">
        <span ref={dotRef} className={`sb-dot ${entry.state}`} aria-hidden="true" />
        <button
          className="sb-bell-read"
          onClick={onMarkRead}
          data-tip="Mark as read"
          aria-label={`Mark “${entry.title}” as read`}
        >
          <Check size={13} />
        </button>
      </span>
    </div>
  )
}
