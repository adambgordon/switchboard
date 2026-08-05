import { memo, type MouseEvent } from 'react'
import type { ConversationMeta, LiveState, PtyState } from '@shared/types'
import { relTime, absShort, basename } from '../lib/format'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'
import { isParkedOnlyRow, isUnlinkedRow } from '../lib/rowIdentity'
import { DashedCircle, Dots } from './icons'
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
  // A live terminal Switchboard cannot show a transcript for. Two ways that happens: a new Codex
  // session it could not match to a rollout (PtyState.provisional), or a Claude session whose work
  // went into a background agent instead of its own transcript (`parkedJob` with nothing indexed —
  // see claudeParkedJobs). Both deliberately get NONE of the four liveness states: they're read off a
  // transcript, and neither terminal has one known to be its, so it remains distinct as `unlinked`.
  // Visually it shares the hollow marker with `quiet` because there are no linked messages to be
  // unread, plus the ordinary empty-row placeholder.
  const parkedOnly = isParkedOnlyRow(live, meta)
  const unlinked = isUnlinkedRow(live, meta)
  // Map the resolved liveness to the dot's modifier class (working reuses the .busy breathe). The dot
  // means "Switchboard owns a terminal for this" — a Claude background agent deliberately gets none,
  // even while its daemon runs. See the work-stream findings note on background liveness dots.
  const liveDotState: LiveState | null =
    live && !unlinked ? liveState ?? (live.status === 'busy' ? 'working' : 'awaiting') : null
  // An unbound Codex terminal reads as `quiet` — live, nothing happening — which is what is actually
  // true of a session that has not had its first turn, and matches a brand-new Claude row beside it.
  // The parked-agent row keeps the neutral dash: its emptiness is permanent rather than a pending
  // first turn, and its preview line says so, where a hollow dot would read as an idle conversation.
  const dotClass = parkedOnly
    ? 'unlinked'
    : unlinked
      ? 'quiet'
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
        <span className="sb-row-title truncate">
          {parkedOnly && live?.parkedJob?.name ? live.parkedJob.name : meta.title}
        </span>
        {parkedOnly ? (
          // This terminal has no conversation of its own — what it produced went into the background
          // agent named above. Without saying so the row reads as an empty, dead conversation while
          // the user is actively working in it.
          <span className="sb-row-preview sb-row-unlinked truncate">
            Terminal only — work is in a background agent
          </span>
        ) : meta.preview ? (
          <span className="sb-row-preview truncate">{meta.preview}</span>
        ) : (
          // No preview (a just-spawned session has no transcript yet) — render a muted
          // placeholder so the row keeps the same height as ones that carry a preview.
          <span className="sb-row-preview sb-row-preview-empty truncate">
            {meta.messageCount === 0 ? 'No messages yet' : 'No preview'}
          </span>
        )}
        <span className="sb-row-meta">
          {meta.agent === 'claude' && meta.sessionKind === 'bg' ? (
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
            <AgentLogo agent={meta.agent} />
          )}
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
            // No data-tip, matching the other markers: hovering the gutter fades the dot out to
            // reveal the ⋮ button, so a tooltip anchored here would point at an invisible element.
            // The visible row uses the shared empty placeholder; this label preserves the exact
            // unlinked meaning for assistive technology.
            aria-label={
              parkedOnly
                ? 'live terminal, work is in a background agent'
                : unlinked
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
