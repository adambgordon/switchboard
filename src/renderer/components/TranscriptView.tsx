import { useCallback, useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from 'react'
import type { Transcript } from '@shared/types'
import MessageBlock from './MessageBlock'
import { buildGroups, type MessageGroup } from '../lib/messageGroups'
import { attachAutoHide } from '../lib/useAutoHideScrollbar'
import { useTranscriptSearch } from '../lib/useTranscriptSearch'

const NOOP = (): void => {}

/** A "You" (human) group — the section divider separates these from Claude/Result/Error turns. */
const isHumanGroup = (g: MessageGroup): boolean => g.label === 'You'

interface TranscriptViewProps {
  transcript: Transcript | null
  loading: boolean
  /** A focus key: a bump counter that changes when the main pane should take the keyboard for the
   *  selected conversation (the Formatted-view twin of TerminalView's focusKey). MainPane derives it
   *  from selectedId — known instantly, before the transcript loads — so the focus lands immediately
   *  on click rather than after the async read. null when nothing is pending. */
  focusKey?: number | null
  /** Dedup store for `focusKey`, owned by MainPane so it survives THIS component unmounting/remounting
   *  (which happens when you navigate across a live conversation shown in its terminal). If the dedup
   *  lived here, a remount would reset it and a stale focusKey would re-grab focus on return — e.g.
   *  arrow away from a selected unlive conversation and back would yank focus into the pane. */
  lastFocusedKeyRef?: MutableRefObject<number | null>
  /** Find-in-conversation query (already deferred). Empty/whitespace clears the search. */
  searchQuery?: string
  /** Index of the active match, driven by the find bar's next/prev. */
  searchActiveIndex?: number
  /** Reports the live match count back up for the n/total readout. */
  onSearchCount?: (n: number) => void
}

/** Distance from the bottom (px) within which we keep the view pinned to latest. */
const NEAR_BOTTOM_PX = 120

function LoadingState(): ReactNode {
  return (
    <div className="transcript-loading">
      <span className="transcript-loading-label label-caps">Reading transcript…</span>
      <div className="transcript-skeleton" aria-hidden="true">
        <span className="skeleton-line skeleton-w-40" />
        <span className="skeleton-line skeleton-w-90" />
        <span className="skeleton-line skeleton-w-75" />
        <span className="skeleton-line skeleton-w-60" />
      </div>
    </div>
  )
}

export default function TranscriptView({
  transcript,
  loading,
  focusKey = null,
  lastFocusedKeyRef,
  searchQuery = '',
  searchActiveIndex = 0,
  onSearchCount = NOOP
}: TranscriptViewProps): ReactNode {
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // Assume we want to be at the bottom until the user scrolls away from it.
  const nearBottomRef = useRef(true)
  const lastSessionRef = useRef<string | null>(null)
  // Detach for the auto-hiding scrollbar, re-bound whenever the scroll node mounts/changes.
  const detachAutoHideRef = useRef<(() => void) | null>(null)

  // Find-in-conversation: highlights matches in the rendered text and scrolls the active one in.
  useTranscriptSearch({
    contentRef,
    scrollRef: scrollElRef,
    query: searchQuery,
    activeIndex: searchActiveIndex,
    revision: transcript ? `${transcript.sessionId}:${transcript.messages.length}` : '',
    onCount: onSearchCount
  })

  const handleScroll = useCallback((): void => {
    const el = scrollElRef.current
    if (!el) return
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }, [])

  // Callback ref: attach/detach the scroll listener + the auto-hiding scrollbar as the container mounts.
  const attachScroll = useCallback(
    (node: HTMLDivElement | null): void => {
      if (scrollElRef.current) {
        scrollElRef.current.removeEventListener('scroll', handleScroll)
        detachAutoHideRef.current?.()
        detachAutoHideRef.current = null
      }
      scrollElRef.current = node
      if (node) {
        node.addEventListener('scroll', handleScroll, { passive: true })
        detachAutoHideRef.current = attachAutoHide(node)
      }
    },
    [handleScroll]
  )

  // Pin to latest: jump to the bottom when a conversation opens; on new content
  // stick to the bottom only if the user is already near it (don't yank them
  // down if they've scrolled up to read history).
  useLayoutEffect(() => {
    const el = scrollElRef.current
    if (!el || !transcript) return
    if (lastSessionRef.current !== transcript.sessionId) {
      lastSessionRef.current = transcript.sessionId
      nearBottomRef.current = true
      el.scrollTop = el.scrollHeight
    } else if (nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [transcript])

  // Focus the scroll container when the main pane should take the keyboard for this conversation —
  // the Formatted-view counterpart to TerminalView grabbing focus on its focusKey. Selecting a
  // not-live conversation routes here (App.clickConversation / ⌥⌘↑/↓ switch → requestFocus → MainPane
  // derives focusKey), so the main pane takes focus, exactly as a live one focuses its terminal. Runs
  // in a LAYOUT effect (before paint) and fires even while the transcript is still loading, so focus
  // lands from the first frame. Dedup on the key so re-renders / switching back to an already-focused
  // conversation don't re-grab; preventScroll so it never fights the pin-to-latest. Dedup against
  // MainPane's ref when provided (survives remounts); fall back to a local ref.
  const localLastFocused = useRef<number | null>(null)
  const lastFocused = lastFocusedKeyRef ?? localLastFocused
  useLayoutEffect(() => {
    if (focusKey == null || focusKey === lastFocused.current) return
    lastFocused.current = focusKey
    scrollElRef.current?.focus({ preventScroll: true })
  }, [focusKey])

  // Coalesce consecutive same-source messages into groups (one header per run). Memoized on the
  // transcript so search-driven re-renders reuse the same group objects and MessageBlock's memo holds.
  const groups = useMemo(
    () => (transcript ? buildGroups(transcript.messages, transcript.agent) : []),
    [transcript]
  )

  if (loading && !transcript) {
    return (
      <div className="transcript-scroll sb-autoscroll" ref={attachScroll} tabIndex={-1}>
        <div className="transcript-content">
          <LoadingState />
        </div>
      </div>
    )
  }

  if (!transcript) return null

  const count = transcript.messages.length

  return (
    <div className="transcript-scroll sb-autoscroll" ref={attachScroll} tabIndex={-1}>
      <div className="transcript-content" ref={contentRef}>
        {groups.map((group, i) => (
          <MessageBlock
            key={group.key}
            group={group}
            dividerBefore={i > 0 && isHumanGroup(group) !== isHumanGroup(groups[i - 1])}
          />
        ))}
        {count > 0 ? (
          <footer className="transcript-foot">
            <span className="transcript-foot-rule" aria-hidden="true" />
            <span className="transcript-foot-label label-caps">
              End of transcript · {count} {count === 1 ? 'message' : 'messages'}
            </span>
          </footer>
        ) : null}
      </div>
    </div>
  )
}
