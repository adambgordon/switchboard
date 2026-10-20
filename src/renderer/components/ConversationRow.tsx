import { memo, useRef, type MouseEvent } from 'react'
import type { ConversationMeta, LiveState, PtyState } from '@shared/types'
import { relTime, formatCount } from '../lib/format'
import type { RailDensity } from '../lib/sidebarPrefs'
import { rowTipPreview, rowTipTitle } from '../lib/rowTip'
import { needsYou } from '../lib/sidebarModel'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'
import { displayTitleForRow, isParkedOnlyRow, liveDotClass } from '../lib/rowIdentity'
import { DashedCircle, Dots, Pin } from './icons'
import AgentLogo from './AgentLogo'

interface Props {
  meta: ConversationMeta
  /** Compact: one line — logo, title, dot — with the rest in the hover. Spacious: title, preview and
   *  a meta line. */
  density: RailDensity
  /** The focused pane's active tab — the one the keyboard acts on. The rail's one inverted row. */
  selected: boolean
  /** Picked into the rail's multi-selection (railSelection), which a group command acts on. */
  picked?: boolean
  /** The folder half of the hover's quiet third line (see `rowTipMeta`). */
  tipMeta: string
  live: PtyState | null
  /** Resolved liveness for the dot (working / asking / awaiting / quiet); null when not live. */
  liveState?: LiveState | null
  pinned: boolean
  /** Hidden by the user, drawn grayed whatever the rail's filter. */
  dimmed?: boolean
  onSelect: (id: string) => void
  /** When set and the row is live, clicking jumps to its terminal instead of previewing. */
  onJump?: (id: string) => void
  /** Double-click — open it as a KEPT tab rather than the replaceable preview one. Absent when tabs
   *  are switched off, which is what makes the gesture inert there rather than half-working. */
  onStick?: (id: string) => void
  /**
   * ⌘-click toggles the row in the rail's selection, ⇧-click selects the run up to it — what picking
   * several out of a list means in every editor and file browser, and what the tab strip does. They
   * never place a conversation: placement is on the ⋮ and right-click menus, which name what they do.
   * Absent where there is no selection to make, which leaves ⌘ and ⇧ with no meaning on the row.
   */
  onPick?: (id: string, how: 'toggle' | 'extend') => void
  /** Option+click on a live row — always mark it unread (never toggles). ⌥ is Switchboard's own
   *  gesture, and wins over ⌘ and ⇧. */
  onMarkUnread?: (id: string) => void
  /** Open the row's actions menu (Pin/Unpin, read/unread, details, Stop/Resume) by clicking the ⋮
   * button; the menu anchors under it. */
  onOpenMenu?: (e: MouseEvent, id: string) => void
  /** Right-click / two-finger click — opens the same actions menu at the cursor. */
  onContextMenu?: (e: MouseEvent, id: string) => void
}

function ConversationRowImpl({
  meta,
  density,
  selected,
  picked,
  tipMeta,
  live,
  liveState,
  pinned,
  dimmed,
  onSelect,
  onJump,
  onStick,
  onPick,
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
  const title = displayTitleForRow(live, meta)
  const lastActive = meta.lastActivityAt ?? meta.mtime
  // The logo slot, which the Claude background-session variant shares: the agent is the one cue a row
  // must carry at rest in a two-agent app, since Resume does materially different things per agent.
  const mark =
    meta.agent === 'claude' && meta.sessionKind === 'bg' ? (
      <span className="sb-bg-agent-mark" role="img" aria-label="Claude Code background session">
        <DashedCircle size={16} className="sb-bg-agent-ring" />
        <span className="sb-bg-agent-logo" aria-hidden="true">
          <AgentLogo agent="claude" size={9} />
        </span>
      </span>
    ) : (
      <AgentLogo agent={meta.agent} />
    )
  // A ⌘- or ⇧-press is a pick, not a landing. Handled on the press, as the tab strip does, so it does
  // not wait on a click a drag or a re-render could swallow.
  const picks = (e: MouseEvent): boolean => !!onPick && !e.altKey && (e.metaKey || e.shiftKey)
  // Whether the latest press picked. What follows it — its click, and a double-click it completes — is
  // judged by the press, not by the keys still held at release: letting go of ⌘ a moment before the
  // button would otherwise land on the row the press had just picked.
  const pickPress = useRef(false)
  return (
    <div
      className={`sb-row ${density}${selected ? ' selected' : ''}${picked ? ' picked' : ''}${live ? ' live' : ''}${pinned ? ' pinned' : ''}${dimmed ? ' dimmed' : ''}${needsYou(liveState ?? null) ? ' attention' : ''}`}
      onPointerDown={(e) => {
        pickPress.current = e.button === 0 && picks(e)
        // ⇧ before ⌘, so ⇧⌘ extends rather than toggling — as on a tab.
        if (pickPress.current) onPick?.(meta.sessionId, e.shiftKey ? 'extend' : 'toggle')
      }}
      // The press only changes the selection, so it must not take focus from wherever the keyboard is —
      // a terminal mid-sentence, say. Canceled on the compatibility mousedown rather than on the
      // pointerdown, which would suppress that mousedown altogether, and with it the tooltip layer's
      // dismissal of the row's hover.
      onMouseDown={(e) => {
        if (pickPress.current) e.preventDefault()
      }}
      onClick={(e) => {
        if (e.altKey) {
          // Option+click = mark unread only; never navigate (selecting/engaging would trip the
          // seen-effect / MainPane's engage listener → markRead, instantly self-clearing it).
          if (live && onMarkUnread) onMarkUnread(meta.sessionId)
          return
        }
        // The press picked it. Landing on it as well would mark it read and move the selected row a
        // range is taken from.
        if (pickPress.current) return
        live && onJump ? onJump(meta.sessionId) : onSelect(meta.sessionId)
      }}
      // Double-click keeps the tab. The two ordinary clicks that precede it (DOM order is
      // click, click, dblclick) each re-open the same conversation, which is idempotent — the second
      // lands on the current history stop and changes nothing — so no click-count dedupe is needed.
      onDoubleClick={(e) => {
        // ⌥ means mark unread here, and ⌘ / ⇧ pick, so none of them may also keep the tab — two
        // ⌘-presses toggle the row in and back out, and that is all the gesture should do.
        if (e.altKey || pickPress.current || !onStick) return
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
      // The drag contract (useBlockReorder): the row is its own unit and its own handle.
      data-key={meta.sessionId}
      data-drag=""
      // The hover carries what a compact row leaves out: the full title, the preview, and when and
      // where. The preview is the tab strip's derivation, so a parked row keeps its explanation; with
      // no real preview the line is omitted rather than spent saying there is nothing to say.
      data-tip={rowTipTitle(title)}
      data-tip-sub={
        rowTipPreview(parkedOnly ? 'Terminal only — work is in a background agent' : meta.preview) ?? undefined
      }
      data-tip-meta={tipMeta}
      data-tip-at={lastActive}
      // Beside the row rather than over its neighbors, and re-filled at once as the pointer sweeps down
      // the list — once one row's hover is up, the rest read without waiting.
      data-tip-scrub=""
    >
      {density === 'compact' ? (
        <>
          <span className="sb-row-lead">{mark}</span>
          <span className="sb-row-title truncate">
            {pinned && <Pin size={10} filled className="sb-row-pin" />}
            {title}
          </span>
        </>
      ) : (
        <span className="sb-row-main">
          <span className="sb-row-title truncate">
            {pinned && <Pin size={10} filled className="sb-row-pin" />}
            {title}
          </span>
          {parkedOnly ? (
            // This terminal has no conversation of its own — what it produced went into the background
            // agent named above. Without saying so the row reads as an empty, dead conversation while
            // the user is actively working in it. Styled as the ordinary empty placeholder; the row's
            // distinction lives in the title and the accessibility label, not in bespoke color.
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
            {mark}
            <span>{relTime(lastActive)}</span>
            <span className="sb-sep" aria-hidden="true" />
            <span>{formatCount(meta.messageCount)} msg</span>
          </span>
        </span>
      )}
      <span className="sb-row-gutter">
        {dotClass && (
          <span
            ref={dotRef}
            className={`sb-dot ${dotClass}`}
            // No data-tip, matching the other markers: hovering the row swaps the dot for the ⋮
            // button, so a tooltip anchored here would point at an invisible element. The label
            // preserves the exact unlinked meaning for assistive technology.
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
          data-no-drag=""
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
