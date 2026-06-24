import type { ConversationMeta, PtyState } from '@shared/types'
import { relTime } from '../lib/format'
import TranscriptSearch from './TranscriptSearch'
import { Pin, Play, Search, Stop, Transcript as TranscriptIcon } from './icons'

type View = 'transcript' | 'terminal'

interface Props {
  title: string
  cwd: string
  meta: ConversationMeta | null
  pty: PtyState | null
  view: View
  pinned: boolean
  onTogglePin: () => void
  onResume: () => void
  onShowHistory: () => void
  onGoLive: () => void
  onKill: () => void
  /** Open the conversation-info modal (clicking the title). */
  onShowInfo: () => void
  /** Find-in-conversation bar state + handlers (the bar renders inline in this header). */
  find: {
    open: boolean
    focusReq: number
    query: string
    count: number
    activeIndex: number
    onQueryChange: (q: string) => void
    onNext: () => void
    onPrev: () => void
    onClose: () => void
    onToggle: () => void
  }
}

export default function PaneHeader({
  title,
  cwd,
  meta,
  pty,
  view,
  pinned,
  onTogglePin,
  onResume,
  onShowHistory,
  onGoLive,
  onKill,
  onShowInfo,
  find
}: Props) {
  const live = !!pty

  return (
    <header className="sb-pane-header">
      <div className="sb-pane-id">
        <button
          type="button"
          className="sb-pane-title sb-pane-title-btn truncate"
          aria-label={`Conversation info: ${title}`}
          onClick={onShowInfo}
        >
          {title}
        </button>
        <div className="sb-pane-meta mono">
          <span className="sb-pane-cwd truncate">{cwd || '—'}</span>
          {meta && (
            <>
              <span className="sb-sep">·</span>
              <span>{meta.messageCount} msg</span>
            </>
          )}
          {meta?.gitBranch && meta.gitBranch !== 'HEAD' && (
            <>
              <span className="sb-sep">·</span>
              <span>{meta.gitBranch}</span>
            </>
          )}
          {meta && (
            <>
              <span className="sb-sep">·</span>
              <span>{relTime(meta.lastActivityAt ?? meta.mtime)}</span>
            </>
          )}
          {!meta && live && (
            <>
              <span className="sb-sep">·</span>
              <span>new session</span>
            </>
          )}
        </div>
      </div>

      {find.open && (
        <TranscriptSearch
          query={find.query}
          focusReq={find.focusReq}
          count={find.count}
          activeIndex={find.activeIndex}
          onQueryChange={find.onQueryChange}
          onNext={find.onNext}
          onPrev={find.onPrev}
          onClose={find.onClose}
        />
      )}

      <div className="sb-pane-actions">
        {/* The magnifier opens find; once open it's hidden — the find bar's own ✕ closes it, sitting
            roughly where the magnifier was, so the two never both show. */}
        {!find.open && (
          <button
            className="sb-pane-find"
            onClick={find.onToggle}
            data-tip="Find in this conversation (⌘F)"
            aria-label="Find in this conversation"
          >
            <Search size={13} />
          </button>
        )}
        <button
          className={`sb-pane-pin${pinned ? ' pinned' : ''}`}
          onClick={onTogglePin}
          data-tip={pinned ? 'Unpin conversation' : 'Pin conversation'}
          aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
          aria-pressed={pinned}
        >
          <Pin size={13} filled={pinned} />
        </button>
        {live ? (
          <>
            <div className="sb-seg" role="tablist">
              <button
                className={`sb-seg-btn${view === 'transcript' ? ' active' : ''}`}
                onClick={onShowHistory}
              >
                <TranscriptIcon size={13} />
                Formatted
              </button>
              <button
                className={`sb-seg-btn${view === 'terminal' ? ' active' : ''}`}
                onClick={onGoLive}
              >
                {/* a static solid cobalt dot — marks the live session; turn-state animation
                    lives on the left-pane rows, not here */}
                <span className="sb-dot" />
                Terminal
              </button>
            </div>
            <button className="sb-btn-ghost danger" onClick={onKill} data-tip="Stop session">
              <Stop size={12} />
              Stop
            </button>
          </>
        ) : (
          <button className="sb-btn-resume" onClick={onResume} data-tip="Resume session (⏎)">
            <Play size={12} />
            Resume
          </button>
        )}
      </div>
    </header>
  )
}
