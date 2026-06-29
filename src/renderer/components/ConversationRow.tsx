import { memo, type MouseEvent } from 'react'
import type { ConversationMeta, LiveState, PtyState } from '@shared/types'
import { relTime, absShort, basename } from '../lib/format'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'
import { Dots } from './icons'
import AgentLogo from './AgentLogo'

interface Props {
  meta: ConversationMeta
  selected: boolean
  live: PtyState | null
  /** Resolved liveness for the dot (working / asking / awaiting / quiet); null when not live. */
  liveState?: LiveState | null
  pinned: boolean
  showCwd?: boolean
  /** Raised card chrome — used by the rail's Pinned/Live sections. */
  card?: boolean
  onSelect: (id: string) => void
  /** When set and the row is live, clicking jumps to its terminal instead of previewing. */
  onJump?: (id: string) => void
  /** Option+click on a live row — always mark it unread (never toggles). */
  onMarkUnread?: (id: string) => void
  /** Open the row's actions menu (Pin/Unpin · read/unread · details · Stop/Resume) by clicking the ⋮
   * button; the menu anchors under it. */
  onOpenMenu?: (e: MouseEvent, id: string) => void
  /** Right-click / two-finger click — opens the same actions menu at the cursor. */
  onContextMenu?: (e: MouseEvent, id: string) => void
}

function ConversationRowImpl({
  meta,
  selected,
  live,
  liveState,
  pinned,
  showCwd,
  card,
  onSelect,
  onJump,
  onMarkUnread,
  onOpenMenu,
  onContextMenu
}: Props) {
  // Map the resolved liveness to the dot's modifier class (working reuses the .busy breathe).
  const liveDotState: LiveState | null = live
    ? liveState ?? (live.status === 'busy' ? 'working' : 'awaiting')
    : null
  const dotClass =
    liveDotState === 'working'
      ? 'busy'
      : liveDotState === 'asking'
        ? 'asking'
        : liveDotState === 'quiet'
          ? 'quiet'
          : 'awaiting'
  // Phase-lock the breathing/ripple to the app-wide beat (a no-op for the static quiet/awaiting dots).
  const dotRef = useSyncedAnimation<HTMLSpanElement>(dotClass)
  return (
    <div
      className={`sb-row${card ? ' card' : ''}${selected ? ' selected' : ''}${live ? ' live' : ''}${pinned ? ' pinned' : ''}`}
      onClick={(e) => {
        if (e.altKey) {
          // Option+click = mark unread only; never navigate (selecting/engaging would trip the
          // seen-effect / MainPane's engage listener → markRead, instantly self-clearing it).
          if (live && onMarkUnread) onMarkUnread(meta.sessionId)
          return
        }
        live && onJump ? onJump(meta.sessionId) : onSelect(meta.sessionId)
      }}
      onContextMenu={(e) => {
        if (!onContextMenu) return
        e.preventDefault()
        onContextMenu(e, meta.sessionId)
      }}
      role="button"
      tabIndex={-1}
      data-session={meta.sessionId}
    >
      <span className="sb-row-main">
        <span className="sb-row-title truncate">{meta.title}</span>
        {meta.preview ? (
          <span className="sb-row-preview truncate">{meta.preview}</span>
        ) : (
          // No preview (a just-spawned session has no transcript yet) — render a muted
          // placeholder so the row keeps the same height as ones that carry a preview.
          <span className="sb-row-preview sb-row-preview-empty truncate">
            {meta.messageCount === 0 ? 'No messages yet' : 'No preview'}
          </span>
        )}
        <span className="sb-row-meta">
          <AgentLogo agent={meta.agent} />
          <span className="mono" data-tip={absShort(meta.lastActivityAt ?? meta.mtime)}>
            {relTime(meta.lastActivityAt ?? meta.mtime)}
          </span>
          <span className="sb-sep">·</span>
          <span className="mono">{meta.messageCount} msg</span>
          {showCwd && (
            <>
              <span className="sb-sep">·</span>
              <span className="sb-row-cwd mono truncate" data-tip={meta.cwd}>
                {basename(meta.cwd)}
              </span>
            </>
          )}
        </span>
      </span>
      <span className="sb-row-gutter">
        {live && (
          <span
            ref={dotRef}
            className={`sb-dot ${dotClass}`}
            aria-label={
              liveDotState === 'working'
                ? 'live, working'
                : liveDotState === 'asking'
                  ? 'live, waiting for your reply'
                  : liveDotState === 'quiet'
                    ? 'live, idle'
                    : 'live, finished — not yet seen'
            }
          />
        )}
        <button
          className="sb-row-menu-btn"
          aria-label="Conversation actions"
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMenu?.(e, meta.sessionId)
          }}
        >
          <Dots size={15} />
        </button>
      </span>
    </div>
  )
}

export default memo(ConversationRowImpl)
