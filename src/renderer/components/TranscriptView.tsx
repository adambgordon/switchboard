import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
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

  // Coalesce consecutive same-source messages into groups (one header per run). Memoized on the
  // transcript so search-driven re-renders reuse the same group objects and MessageBlock's memo holds.
  const groups = useMemo(() => (transcript ? buildGroups(transcript.messages) : []), [transcript])

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
