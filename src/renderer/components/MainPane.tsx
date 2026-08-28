import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from 'react'
import type { ConversationMeta, PtyState, Transcript } from '@shared/types'
import type { ResolvedTheme } from '../lib/theme'
import PaneHeader from './PaneHeader'
import TabStrip, { type TabDescriptor } from './TabStrip'
import TranscriptView, { type TranscriptScrollState } from './TranscriptView'
import TerminalDeck from './TerminalDeck'
import { Play } from './icons'
import { useSyncedAnimation } from '../lib/useSyncedAnimation'

type View = 'transcript' | 'terminal'

interface Props {
  selectedId: string | null
  /** Which pane this is, for the tab callbacks (0 when unsplit). */
  paneIndex: number
  /** Whether this pane owns the keyboard — only its active tab reads fully selected. */
  paneFocused: boolean
  /** Flex sizing for the split. Undefined when there is a single pane. */
  style?: CSSProperties
  /** A pointer landing anywhere in this pane hands it the keyboard. */
  onPaneFocus?: () => void
  /** Live, but its terminal is mounted in the other pane — one xterm per terminal, so this pane shows
   *  the transcript and says where the terminal is rather than offering a toggle that cannot work. */
  terminalElsewhere?: boolean
  /** Preferences → Application → Tabs and split view. False renders no strip at all. */
  showTabs: boolean
  tabs: TabDescriptor[]
  activeTabIndex: number
  onActivateTab: (pane: number, index: number) => void
  onCloseTab: (pane: number, index: number) => void
  onCloseOtherTabs: (pane: number, index: number) => void
  onPromoteTab: (sessionId: string, pane?: number) => void
  /** Open the conversation-info modal for an arbitrary conversation (the tab menu's Session Details). */
  onShowInfoFor: (sessionId: string) => void
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
  /** This row stands for no conversation — see PaneHeader, which hides its conversation-keyed controls. */
  unlinked: boolean
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
  /** Preferences → Application: copy Formatted-view selections as Markdown rather than rendered text. */
  markdownCopy: boolean
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
    paneIndex,
    paneFocused,
    style,
    onPaneFocus,
    terminalElsewhere,
    showTabs,
    tabs,
    activeTabIndex,
    onActivateTab,
    onCloseTab,
    onCloseOtherTabs,
    onPromoteTab,
    onShowInfoFor,
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
    unlinked,
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
    onFindToggle,
    markdownCopy
  } = props

  const showTerminal = !!selectedId && view === 'terminal' && !!pty
  const showTranscript = !!selectedId && !showTerminal
  const visiblePtyId = showTerminal && pty ? pty.ptyId : null
  // Formatted-view focus key: bumps when a focus is requested for the selected conversation (a
  // not-live row click or ⌥⌘↑/↓ switch), so TranscriptView takes the keyboard like the terminal does
  // on a live one. Derived from selectedId — known instantly — so focus lands during the async
  // transcript load, not after.
  // Gated on `paneFocused` as well as the session: the same conversation can be the active tab of
  // BOTH panes, and without this both transcripts would answer the same focus request and fight over
  // the keyboard. Only the pane that has it may take it.
  const transcriptFocusKey =
    focusReq && focusReq.sessionId === selectedId && paneFocused ? focusReq.n : null
  // Dedup store for the transcript focus, kept HERE so it survives TranscriptView unmounting/remounting
  // (switching across a live conversation shown in its terminal unmounts it). Otherwise a remount resets
  // the dedup and a stale focusReq re-grabs focus on return — switching back to a previously-focused
  // not-live conversation would re-pull focus on each remount.
  const transcriptFocusKeyRef = useRef<number | null>(null)
  // Compact per-conversation Formatted state. MainPane stays mounted while TranscriptView comes and
  // goes, so positions survive both conversation switches and Formatted↔Terminal toggles without
  // retaining every Markdown tree in the DOM.
  const transcriptScrollStateRef = useRef(new Map<string, TranscriptScrollState>())

  // --- find in conversation (the main-pane search; distinct from the rail's cross-conversation
  // search). Query state is local so keystrokes re-render only the pane, not App / the rail. ---
  const [findQuery, setFindQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  // Defer the query feeding the DOM-walking search so typing stays responsive on big transcripts.
  const deferredQuery = useDeferredValue(findQuery)

  // Closing the bar clears the search. activeIndex is deliberately NOT reset here: the [deferredQuery]
  // effect below already resets it on every query change (including this clear-to-empty), coupled to the
  // DEFERRED query. Resetting it here — immediately, while deferredQuery still lags on the old query —
  // made the search hook briefly see (index 0, old query, still-live ranges) and scroll back to match #0
  // on close (the "snap back to where I opened search" bug).
  useEffect(() => {
    if (!findOpen) {
      setFindQuery('')
      setMatchCount(0)
    }
  }, [findOpen])
  // A fresh (or cleared) query resets to the first match — in step with the deferred query the hook uses.
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
    <main
      className={`sb-pane${paneFocused ? ' pane-focused' : ''}`}
      ref={paneRef}
      tabIndex={-1}
      style={style}
      // Capture phase: a pointer landing anywhere in this pane — strip, header, transcript, or the
      // terminal — hands it the keyboard, before xterm or the transcript consume the event. It only
      // records which pane is active, so nothing is prevented or stopped here.
      onMouseDownCapture={onPaneFocus}
    >
      {/* Tabs sit ABOVE the header: the strip says which conversations are open, the header describes
          the one you are in. The strip renders whenever the feature is on and this pane holds a tab —
          including while the welcome screen shows, since the tabs are still there to go back to. */}
      {showTabs && tabs.length > 0 && (
        <TabStrip
          paneIndex={paneIndex}
          tabs={tabs}
          activeIndex={activeTabIndex}
          focused={paneFocused}
          onActivate={onActivateTab}
          onClose={onCloseTab}
          onCloseOthers={onCloseOtherTabs}
          onPromote={onPromoteTab}
          onShowInfo={onShowInfoFor}
        />
      )}
      {selectedId && (
        <PaneHeader
          title={title}
          cwd={cwd}
          meta={meta}
          pty={pty}
          view={view}
          pinned={pinned}
          unlinked={unlinked}
          terminalElsewhere={terminalElsewhere}
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
                messageCount={meta?.messageCount ?? 0}
                scrollStateRef={transcriptScrollStateRef}
                focusKey={transcriptFocusKey}
                lastFocusedKeyRef={transcriptFocusKeyRef}
                searchQuery={deferredQuery}
                searchActiveIndex={activeIndex}
                onSearchCount={setMatchCount}
                markdownCopy={markdownCopy}
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
