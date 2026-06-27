import { useCallback, useDeferredValue, useEffect, useRef, useState, type RefObject } from 'react'
import type { ConversationMeta, PtyState, Transcript } from '@shared/types'
import type { ResolvedTheme } from '../lib/theme'
import PaneHeader from './PaneHeader'
import TranscriptView from './TranscriptView'
import TerminalDeck from './TerminalDeck'
import { Play } from './icons'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'

type View = 'transcript' | 'terminal'

interface Props {
  selectedId: string | null
  title: string
  cwd: string
  meta: ConversationMeta | null
  pty: PtyState | null
  view: View
  /** Resolved app theme, forwarded to the terminal deck for live re-skinning. */
  theme: ResolvedTheme
  focusReq: { sessionId: string; n: number } | null
  transcript: Transcript | null
  transcriptLoading: boolean
  activePtys: PtyState[]
  pinned: boolean
  onTogglePin: () => void
  onResume: () => void
  onShowHistory: () => void
  onGoLive: () => void
  onKill: () => void
  /** Open the conversation-info modal (clicking the pane title). */
  onShowInfo: () => void
  /** Genuine engagement with the open conversation (a click or keystroke in the pane body) —
   *  used to clear a manual "unread" mark once you actually start working in it. */
  onEngage?: () => void
  /** Option+click in the terminal — always mark the conversation unread (never toggles). */
  onMarkUnread: (id: string) => void
  /** Ref to the pane root (`.sb-pane`); App reads it to route ⌘F when focus is in the main pane. */
  paneRef: RefObject<HTMLElement>
  /** Whether the find-in-conversation bar is open (App owns the toggle; ⌘F / Esc drive it). */
  findOpen: boolean
  /** Bumped on each ⌘F while focus is in the main pane, so the find input re-focuses even when the
   *  bar is already open (e.g. after clicking into the transcript). */
  findFocusReq: number
  /** Close the find bar. */
  onFindClose: () => void
  /** First keystroke in find while the live Terminal is showing → switch to Formatted to search. */
  onFindActivate: () => void
  /** Toggle the find bar from the pane-header magnifier. */
  onFindToggle: () => void
}

function EmptyState() {
  const markRef = useSyncedAnimation<HTMLSpanElement>('mark')
  return (
    <div className="sb-pane-empty">
      <span className="sb-empty-mark" ref={markRef} />
      <div className="sb-empty-head">
        <div className="sb-empty-title">A switchboard for your AI coding sessions</div>
        <div className="sb-empty-tagline">Your Claude Code setup. Your Codex setup. One unified app.</div>
      </div>
      <div className="sb-empty-body sb-empty-lead">
        Select any conversation to preview its transcript — instantly, without starting it.
      </div>
      <div className="sb-empty-keys label-caps">
        <span>
          <kbd>⌘N</kbd> new
        </span>
        <span>
          <kbd>⌘[</kbd> <kbd>⌘]</kbd> back / forward
        </span>
        <span>
          <kbd>⌘?</kbd> shortcuts
        </span>
      </div>
    </div>
  )
}

function NoHistory({ live, onGoLive }: { live: boolean; onGoLive: () => void }) {
  return (
    <div className="sb-pane-empty">
      <div className="sb-empty-title">No transcript yet</div>
      <div className="sb-empty-body">
        {live
          ? 'This session is just getting started — nothing has been written to disk yet.'
          : 'This conversation has no readable history.'}
      </div>
      {live && (
        <button className="sb-btn-resume" onClick={onGoLive}>
          <Play size={13} />
          Go to live session
        </button>
      )}
    </div>
  )
}

export default function MainPane(props: Props) {
  const {
    selectedId,
    title,
    cwd,
    meta,
    pty,
    view,
    theme,
    focusReq,
    transcript,
    transcriptLoading,
    activePtys,
    pinned,
    onTogglePin,
    onResume,
    onShowHistory,
    onGoLive,
    onKill,
    onShowInfo,
    onEngage,
    onMarkUnread,
    paneRef,
    findOpen,
    findFocusReq,
    onFindClose,
    onFindActivate,
    onFindToggle
  } = props

  const showTerminal = !!selectedId && view === 'terminal' && !!pty
  const showTranscript = !!selectedId && !showTerminal
  const visiblePtyId = showTerminal && pty ? pty.ptyId : null
  // Formatted-view focus key: bumps when a focus is requested for the selected conversation (a
  // not-live row click or ⌥⌘↑/↓ switch), so TranscriptView takes the keyboard like the terminal does
  // on a live one. Derived from selectedId — known instantly — so focus lands during the async
  // transcript load, not after.
  const transcriptFocusKey = focusReq && focusReq.sessionId === selectedId ? focusReq.n : null
  // Dedup store for the transcript focus, kept HERE so it survives TranscriptView unmounting/remounting
  // (switching across a live conversation shown in its terminal unmounts it). Otherwise a remount resets
  // the dedup and a stale focusReq re-grabs focus on return — switching back to a previously-focused
  // not-live conversation would re-pull focus on each remount.
  const transcriptFocusKeyRef = useRef<number | null>(null)

  // --- find in conversation (the main-pane search; distinct from the rail's cross-conversation
  // search). Query state is local so keystrokes re-render only the pane, not App / the rail. ---
  const [findQuery, setFindQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  // Defer the query feeding the DOM-walking search so typing stays responsive on big transcripts.
  const deferredQuery = useDeferredValue(findQuery)

  // Closing the bar clears the search; a fresh query resets to the first match.
  useEffect(() => {
    if (!findOpen) {
      setFindQuery('')
      setActiveIndex(0)
      setMatchCount(0)
    }
  }, [findOpen])
  useEffect(() => {
    setActiveIndex(0)
  }, [deferredQuery])

  // First real keystroke while the live Terminal is showing: hand off to App to switch to the
  // Formatted view (the only searchable surface). Idempotent — App no-ops once already there.
  useEffect(() => {
    if (findOpen && findQuery.trim() && view === 'terminal') onFindActivate()
  }, [findOpen, findQuery, view, onFindActivate])

  const nextMatch = useCallback(() => {
    setActiveIndex((i) => (matchCount ? (i + 1) % matchCount : 0))
  }, [matchCount])
  const prevMatch = useCallback(() => {
    setActiveIndex((i) => (matchCount ? (i - 1 + matchCount) % matchCount : 0))
  }, [matchCount])

  // Engagement in the conversation body — a left-click, or typing into the terminal — marks the
  // open conversation read. The keydown listener runs in the *capture* phase: xterm stops keydown
  // propagation while focused, so a bubble-phase listener would never see typing — capture fires
  // on the way down, before xterm swallows it. Shortcut chords (⇧⌘U etc.) are skipped so marking it
  // unread doesn't immediately self-clear. (Scrolling isn't engagement; navigation is handled upstream.)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bodyRef.current
    if (!el || !onEngage) return
    const onDown = (e: MouseEvent): void => {
      if (e.button === 0) onEngage()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey && !e.ctrlKey) onEngage()
    }
    el.addEventListener('mousedown', onDown)
    el.addEventListener('keydown', onKey, true)
    return () => {
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('keydown', onKey, true)
    }
  }, [onEngage])

  return (
    <main className="sb-pane" ref={paneRef} tabIndex={-1}>
      {selectedId && (
        <PaneHeader
          title={title}
          cwd={cwd}
          meta={meta}
          pty={pty}
          view={view}
          pinned={pinned}
          onTogglePin={onTogglePin}
          onResume={onResume}
          onShowHistory={onShowHistory}
          onGoLive={onGoLive}
          onKill={onKill}
          onShowInfo={onShowInfo}
          find={{
            open: findOpen,
            focusReq: findFocusReq,
            query: findQuery,
            count: matchCount,
            activeIndex,
            onQueryChange: setFindQuery,
            onNext: nextMatch,
            onPrev: prevMatch,
            onClose: onFindClose,
            onToggle: onFindToggle
          }}
        />
      )}
      <div className="sb-pane-body" ref={bodyRef}>
        {!selectedId && <EmptyState />}
        {showTranscript &&
          (transcript || transcriptLoading ? (
            <div className="sb-pane-layer">
              <TranscriptView
                transcript={transcript}
                loading={transcriptLoading}
                focusKey={transcriptFocusKey}
                lastFocusedKeyRef={transcriptFocusKeyRef}
                searchQuery={deferredQuery}
                searchActiveIndex={activeIndex}
                onSearchCount={setMatchCount}
              />
            </div>
          ) : (
            <NoHistory live={!!pty} onGoLive={onGoLive} />
          ))}
        <TerminalDeck
          activePtys={activePtys}
          visiblePtyId={visiblePtyId}
          deckVisible={showTerminal}
          focusReq={focusReq}
          theme={theme}
          onMarkUnread={onMarkUnread}
        />
      </div>
    </main>
  )
}
