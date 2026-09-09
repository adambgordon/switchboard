import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type RefObject
} from 'react'
import type { ConversationMeta, PtyState, Transcript } from '@shared/types'
import PaneHeader from './PaneHeader'
import TabStrip, { type TabDescriptor } from './TabStrip'
import TranscriptView, { type TranscriptScrollState } from './TranscriptView'
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
  /** Where this conversation's live terminal is. One xterm per terminal, so a pane that does not hold
   *  it shows the transcript and says where it is — and, across windows, offers to move it. */
  terminalAt?: 'here' | 'other-pane' | 'claimable' | null
  /** Bring the terminal into this window and show it here. */
  onClaimTerminal?: () => void
  /** Preferences → Beta Features → Tabs and split view. False renders no strip at all. */
  showTabs: boolean
  tabs: TabDescriptor[]
  activeTabIndex: number
  onActivateTab: (pane: number, index: number, focusSurface?: boolean) => void
  onCloseTab: (pane: number, index: number) => void
  onCloseOtherTabs: (pane: number, index: number) => void
  onPromoteTab: (sessionId: string, pane?: number) => void
  /** See TabStrip: whether the tab can create the split, and whether it can cross an existing one. */
  canSplitRight: (sessionId: string) => boolean
  canMoveToOtherPane: boolean
  onSplitRightTab: (sessionId: string, pane: number) => void
  onMoveTabToOtherPane: (sessionId: string, pane: number) => void
  onOpenTabInNewWindow: (sessionId: string) => void
  /** A tab was dragged onto a strip in this window. */
  onMoveTab: (from: { pane: number; index: number }, to: { pane: number; index: number }) => void
  /** A tab group was dragged out of this window entirely. */
  onTabLeftWindow: (sessionIds: string[]) => void
  /** Multi-selection: which tabs are in it, the two gestures that build it, and the group forms of
   *  drop and target-resolution. */
  selectedTabIds: Set<string>
  onToggleTabSelect: (pane: number, sessionId: string) => void
  onExtendTabSelect: (pane: number, sessionId: string) => void
  onMoveTabGroup: (
    sessionIds: string[],
    activeSessionId: string,
    to: { pane: number; index: number }
  ) => void
  onResolveTabTargets: (pane: number, sessionId: string) => string[]
  /** Open the conversation-info modal for an arbitrary conversation (the tab menu's Session Details). */
  onShowInfoFor: (sessionId: string) => void
  title: string
  cwd: string
  meta: ConversationMeta | null
  pty: PtyState | null
  view: View
  focusReq: { sessionId: string; n: number } | null
  transcript: Transcript | null
  transcriptLoading: boolean
  transcriptScrollStateRef: MutableRefObject<Map<string, TranscriptScrollState>>
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
  onEngage?: (id: string) => void
  /** Stable portal target for every xterm homed to this pane. */
  terminalHostRef: (node: HTMLDivElement | null) => void
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
    terminalAt,
    onClaimTerminal,
    showTabs,
    tabs,
    activeTabIndex,
    onActivateTab,
    onCloseTab,
    onCloseOtherTabs,
    onPromoteTab,
    canSplitRight,
    canMoveToOtherPane,
    onSplitRightTab,
    onMoveTabToOtherPane,
    onOpenTabInNewWindow,
    onMoveTab,
    onTabLeftWindow,
    selectedTabIds,
    onToggleTabSelect,
    onExtendTabSelect,
    onMoveTabGroup,
    onResolveTabTargets,
    onShowInfoFor,
    title,
    cwd,
    meta,
    pty,
    view,
    focusReq,
    transcript,
    transcriptLoading,
    transcriptScrollStateRef,
    pinned,
    unlinked,
    onTogglePin,
    onResume,
    onShowHistory,
    onGoLive,
    onKill,
    onShowInfo,
    onEngage,
    terminalHostRef,
    paneRef,
    findOpen,
    findFocusReq,
    onFindClose,
    onFindActivate,
    onFindToggle,
    markdownCopy
  } = props
  const onPaneFocusRef = useRef(onPaneFocus)
  onPaneFocusRef.current = onPaneFocus

  const showTerminal = !!selectedId && view === 'terminal' && !!pty
  const showTranscript = !!selectedId && !showTerminal
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
    if (!el || !onEngage || !selectedId) return
    const onDown = (e: MouseEvent): void => {
      if (e.button === 0) onEngage(selectedId)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey && !e.ctrlKey) onEngage(selectedId)
    }
    el.addEventListener('mousedown', onDown)
    el.addEventListener('keydown', onKey, true)
    return () => {
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('keydown', onKey, true)
    }
  }, [onEngage, selectedId])

  // TerminalView is portalled into this pane from a sibling React subtree, so React's synthetic
  // events follow TerminalDeck rather than this component. A native capture listener follows the
  // physical DOM instead, keeping pane ownership aligned with the terminal that actually took focus.
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const onDown = (): void => onPaneFocusRef.current?.()
    el.addEventListener('pointerdown', onDown, true)
    return () => el.removeEventListener('pointerdown', onDown, true)
  }, [paneRef])

  return (
    <main
      className={`sb-pane${paneFocused ? ' pane-focused' : ''}`}
      ref={paneRef}
      tabIndex={-1}
      style={style}
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
          canSplitRight={canSplitRight}
          canMoveToOtherPane={canMoveToOtherPane}
          onSplitRight={onSplitRightTab}
          onMoveToOtherPane={onMoveTabToOtherPane}
          onOpenInNewWindow={onOpenTabInNewWindow}
          onMoveTab={onMoveTab}
          onTabLeftWindow={onTabLeftWindow}
          selectedIds={selectedTabIds}
          onToggleSelect={onToggleTabSelect}
          onExtendSelect={onExtendTabSelect}
          onMoveTabGroup={onMoveTabGroup}
          onResolveTargets={onResolveTabTargets}
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
          terminalAt={terminalAt}
          onClaimTerminal={onClaimTerminal}
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
        <div
          className="sb-term-deck"
          ref={terminalHostRef}
          style={{ display: showTerminal ? 'block' : 'none' }}
        />
      </div>
    </main>
  )
}
