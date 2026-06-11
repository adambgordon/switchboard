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
  find
}: Props) {
  const live = !!pty

  return (
    <header className="sb-pane-header">
      <div className="sb-pane-id">
        <h1 className="sb-pane-title truncate" data-tip={title}>
          {title}
        </h1>
        <div className="sb-pane-meta mono">
          <span className="sb-pane-cwd truncate" data-tip={cwd}>
            {cwd || '—'}
          </span>
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
        <button
          className={`sb-pane-find${find.open ? ' active' : ''}`}
          onClick={find.onToggle}
          data-tip="Find in this conversation (⌘F)"
          aria-label="Find in this conversation"
          aria-pressed={find.open}
        >
          <Search size={13} />
        </button>
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
