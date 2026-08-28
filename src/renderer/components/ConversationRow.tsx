import { memo, type MouseEvent } from 'react'
import type { ConversationMeta, LiveState, PtyState } from '@shared/types'
import { relTime, absShort, basename } from '../lib/format'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'
import { displayTitleForRow, isParkedOnlyRow, liveDotClass } from '../lib/rowIdentity'
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
  /** Double-click — open it as a KEPT tab rather than the replaceable preview one. Absent when tabs
   *  are switched off, which is what makes the gesture inert there rather than half-working. */
  onStick?: (id: string) => void
  /** ⌘+click — open a kept tab in the background, without going there (the browser gesture). */
  onOpenInBackground?: (id: string) => void
  /** ⇧+click — open it in the OTHER pane, creating the split if there isn't one. */
  onOpenToSide?: (id: string) => void
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
  onStick,
  onOpenInBackground,
  onOpenToSide,
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
  // Which dot to draw. Shared with the tab strip, which draws the SAME session at the same moment —
  // see liveDotClass for why that has to be one derivation rather than two agreeing ones.
  const dotClass = liveDotClass(live, meta, liveState)
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
        if (e.shiftKey && onOpenToSide) {
          // ⇧+click = open beside. Checked before ⌘ so ⇧⌘+click reads as the side open rather than
          // silently doing the background one.
          onOpenToSide(meta.sessionId)
          return
        }
        if (e.metaKey && onOpenInBackground) {
          // ⌘+click = open a kept tab without going there. Checked before the live/not-live split
          // because it means the same thing on either kind of row, and it must not also navigate.
          onOpenInBackground(meta.sessionId)
          return
        }
        live && onJump ? onJump(meta.sessionId) : onSelect(meta.sessionId)
      }}
      // Double-click keeps the tab. The two ordinary clicks that precede it (DOM order is
      // click, click, dblclick) each re-open the same conversation, which is idempotent — the second
      // lands on the current history stop and changes nothing — so no click-count dedupe is needed.
      onDoubleClick={(e) => {
        if (e.altKey || e.metaKey || e.shiftKey || !onStick) return
        onStick(meta.sessionId)
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
        <span className="sb-row-title truncate">{displayTitleForRow(live, meta)}</span>
        {parkedOnly ? (
          // This terminal has no conversation of its own — what it produced went into the background
          // agent named above. Without saying so the row reads as an empty, dead conversation while
          // the user is actively working in it. Styled as the ordinary empty placeholder: the
          // dedicated unlinked treatment was retired, and the row's distinction now lives in the
          // title, the Live tally, and the accessibility label rather than in bespoke preview color.
          <span className="sb-row-preview sb-row-preview-empty truncate">
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
        {dotClass && (
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
                : dotClass === 'unlinked'
                  ? 'live terminal, transcript not linked'
                  : dotClass === 'busy'
                    ? 'live, working'
                    : dotClass === 'asking'
                      ? 'live, waiting for your reply'
                      : dotClass === 'quiet'
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
