import { memo, type MouseEvent } from 'react'
import type { ConversationMeta, LiveState, PtyState } from '@shared/types'
import { relTime, absShort, basename } from '../lib/format'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'
import { DashedCircle, Dots } from './icons'
import AgentLogo from './AgentLogo'

interface Props {
  sessionId: string
  orderKey: string
  meta: ConversationMeta | null
  host: boolean
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
  sessionId,
  orderKey,
  meta,
  host,
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
  // A live terminal that stands for no conversation — either its identity was never proven (a new
  // Codex session Switchboard could not match to a rollout, see PtyState.provisional) or it is a
  // Claude Agent View viewer, which has no transcript by construction. Both deliberately get NONE of
  // the four liveness states: those are read off a transcript, and neither terminal has one known to
  // be its, so any dot would describe someone else's conversation. Neutral marker + explicit copy
  // instead, because failing closed silently reads as a duplicated or broken row.
  const unlinked = host || live?.provisional === true
  // Map the resolved liveness to the dot's modifier class (working reuses the .busy breathe). A
  // running background job has no PTY to fall back on, so its dot rests on the transcript alone.
  const liveDotState: LiveState | null = unlinked
    ? null
    : live
      ? liveState ?? (live.status === 'busy' ? 'working' : 'awaiting')
      : meta?.bgRunning
        ? liveState ?? 'quiet'
        : null
  const dotClass = unlinked
    ? 'unlinked'
    : liveDotState === 'working'
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
          if (live && !host && onMarkUnread) onMarkUnread(sessionId)
          return
        }
        live && onJump ? onJump(sessionId) : onSelect(sessionId)
      }}
      onContextMenu={(e) => {
        if (!onContextMenu) return
        e.preventDefault()
        onContextMenu(e, sessionId)
      }}
      role="button"
      tabIndex={-1}
      data-row={live?.ptyId ?? sessionId}
      data-order={orderKey}
    >
      <span className="sb-row-main">
        <span className="sb-row-title truncate">
          {host ? 'Claude Agent View' : meta?.title}
        </span>
        {unlinked ? (
          // Say plainly what this row is, in the slot a preview would occupy. Without this the row
          // looks like an empty duplicate of a real conversation sitting in Recent — the two rows are
          // a terminal whose transcript is unknown and a transcript whose terminal is unknown, and
          // that only makes sense if the terminal admits it. A viewer says which of the two it is,
          // since its missing transcript is by design rather than a failed match.
          <span className="sb-row-preview sb-row-unlinked truncate">
            {host ? 'Terminal only — viewing background agents' : 'Terminal only — transcript not linked'}
          </span>
        ) : meta?.preview ? (
          <span className="sb-row-preview truncate">{meta.preview}</span>
        ) : (
          // No preview (a just-spawned session has no transcript yet) — render a muted
          // placeholder so the row keeps the same height as ones that carry a preview.
          <span className="sb-row-preview sb-row-preview-empty truncate">
            {meta?.messageCount === 0 ? 'No messages yet' : 'No preview'}
          </span>
        )}
        <span className="sb-row-meta">
          {!host && meta?.agent === 'claude' && meta.sessionKind === 'bg' ? (
            <span
              className="sb-bg-agent-mark"
              data-tip="Claude Code background session"
              role="img"
              aria-label="Claude Code background session"
            >
              <DashedCircle size={16} className="sb-bg-agent-ring" />
              <span className="sb-bg-agent-logo" aria-hidden="true">
                <AgentLogo agent="claude" size={9} />
              </span>
            </span>
          ) : (
            <AgentLogo agent={host ? 'claude' : (meta?.agent ?? 'claude')} />
          )}
          {host ? (
            <span className="mono">terminal host</span>
          ) : (
            <>
              <span className="mono" data-tip={absShort(meta?.lastActivityAt ?? meta?.mtime ?? 0)}>
                {relTime(meta?.lastActivityAt ?? meta?.mtime ?? 0)}
              </span>
              <span className="sb-sep">·</span>
              <span className="mono">{meta?.messageCount ?? 0} msg</span>
            </>
          )}
          {showCwd && (
            <>
              <span className="sb-sep">·</span>
              <span className="sb-row-cwd mono truncate" data-tip={meta?.cwd ?? live?.cwd ?? ''}>
                {basename(meta?.cwd ?? live?.cwd ?? '')}
              </span>
            </>
          )}
        </span>
      </span>
      <span className="sb-row-gutter">
        {(live || meta?.bgRunning) && (
          <span
            ref={dotRef}
            className={`sb-dot ${dotClass}`}
            // No data-tip, matching the other four states: hovering the gutter fades the dot out to
            // reveal the ⋮ button, so a tooltip anchored here would point at an invisible element.
            // The row's own preview line carries the explanation in visible text instead.
            aria-label={
              unlinked
                ? 'live terminal, transcript not linked'
                : liveDotState === 'working'
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
            onOpenMenu?.(e, sessionId)
          }}
        >
          <Dots size={15} />
        </button>
      </span>
    </div>
  )
}

export default memo(ConversationRowImpl)
