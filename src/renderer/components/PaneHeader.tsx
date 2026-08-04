import type { ConversationMeta, PtyState } from '@shared/types'
import { relTime, absShort } from '../lib/format'
import AgentLogo from './AgentLogo'
import TranscriptSearch from './TranscriptSearch'
import { Pin, Play, Search, Stop, Transcript as TranscriptIcon } from './icons'

type View = 'transcript' | 'terminal'

interface Props {
  title: string
  cwd: string
  meta: ConversationMeta | null
  pty: PtyState | null
  agentViewHost: boolean
  agentViewController: boolean
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
  agentViewHost,
  agentViewController,
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
  const agent = meta?.agent ?? pty?.agent ?? null
  const agentViewTransport = pty?.surface.kind === 'agent-view-host'

  return (
    <header className="sb-pane-header">
      <div className="sb-pane-id">
        {agentViewHost ? (
          <span className="sb-pane-title truncate">{title}</span>
        ) : (
          <button
            type="button"
            className="sb-pane-title sb-pane-title-btn truncate"
            aria-label={`Conversation info: ${title}`}
            onClick={onShowInfo}
          >
            {title}
          </button>
        )}
        <div className="sb-pane-meta mono">
          {agent && <AgentLogo agent={agent} size={13} />}
          {agentViewHost ? (
            <>
              <span>terminal host</span>
              <span className="sb-sep">·</span>
              <span className="sb-pane-cwd truncate">{cwd || '—'}</span>
            </>
          ) : meta ? (
            <>
              <span data-tip={absShort(meta.lastActivityAt ?? meta.mtime)}>
                {relTime(meta.lastActivityAt ?? meta.mtime)}
              </span>
              <span className="sb-sep">·</span>
              <span>{meta.messageCount} msg</span>
              <span className="sb-sep">·</span>
              <span className="sb-pane-cwd truncate">{cwd || '—'}</span>
              {meta.gitBranch && meta.gitBranch !== 'HEAD' && (
                <>
                  <span className="sb-sep">·</span>
                  <span>{meta.gitBranch}</span>
                </>
              )}
            </>
          ) : (
            <>
              {live && (
                <>
                  <span>new session</span>
                  <span className="sb-sep">·</span>
                </>
              )}
              <span className="sb-pane-cwd truncate">{cwd || '—'}</span>
            </>
          )}
        </div>
      </div>

      {find.open && !agentViewHost && (
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
        {!agentViewHost && !find.open && (
          <button
            className="sb-pane-find"
            onClick={find.onToggle}
            data-tip="Find in this conversation (⌘F)"
            aria-label="Find in this conversation"
          >
            <Search size={13} />
          </button>
        )}
        {!agentViewHost && (
          <button
            className={`sb-pane-pin${pinned ? ' pinned' : ''}`}
            onClick={onTogglePin}
            data-tip={pinned ? 'Unpin conversation' : 'Pin conversation'}
            aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
            aria-pressed={pinned}
          >
            <Pin size={13} filled={pinned} />
          </button>
        )}
        {live ? (
          <>
            <div className="sb-seg" role="tablist">
              {!agentViewHost && (
                <button
                  className={`sb-seg-btn${view === 'transcript' ? ' active' : ''}`}
                  onClick={onShowHistory}
                >
                  <TranscriptIcon size={13} />
                  Formatted
                </button>
              )}
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
            <button
              className="sb-btn-ghost danger"
              onClick={onKill}
              data-tip={agentViewTransport ? 'Stop Agent View' : 'Stop session'}
            >
              <Stop size={12} />
              {agentViewTransport ? 'Stop Agent View' : 'Stop'}
            </button>
          </>
        ) : (
          <button
            className="sb-btn-resume"
            onClick={onResume}
            data-tip={agentViewController ? 'Go to Agent View (⏎)' : 'Resume session (⏎)'}
          >
            <Play size={12} />
            {agentViewController ? 'Go to Agent View' : 'Resume'}
          </button>
        )}
      </div>
    </header>
  )
}
