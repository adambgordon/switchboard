import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import type { Transcript } from '@shared/types'
import MessageBlock from './MessageBlock'
import { Arrow } from './icons'
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

/** Render-windowing: mount only the last WINDOW groups on open, then grow toward the full set in
 *  GROW_STEP-sized idle chunks. Keeps first paint of a long transcript instant — the dominant cost is
 *  mounting each group's ReactMarkdown, so capping the initial mount is what makes it feel instant. */
const WINDOW = 60
const GROW_STEP = 120

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
  // rAF handle for the on-open "keep snapping to the bottom until the height settles" loop.
  const repinRafRef = useRef<number | null>(null)

  // Jump-to-edge affordance — reactive flags for whether the scroll sits near the top / bottom, driving
  // the floating buttons (shown only when scrolled away from that edge). nearBottomRef below stays the
  // imperative pin-to-latest signal; these are the React-state twin so the buttons re-render on scroll.
  const [atTop, setAtTop] = useState(true)
  const [atBottom, setAtBottom] = useState(true)
  // Render-windowing (see WINDOW above): how many trailing groups are currently mounted.
  const [visibleCount, setVisibleCount] = useState(WINDOW)
  // pre-grow scrollHeight: recorded just before a chunk mounts so the layout effect can add the
  // prepended height back to scrollTop (otherwise the viewport jumps down by what we mounted above).
  const growHeightRef = useRef<number | null>(null)
  // set when a jump-to-top needs the full transcript mounted first; consumed once it is.
  const pendingTopRef = useRef(false)
  const measureEdges = useCallback((el: HTMLDivElement): void => {
    const top = el.scrollTop <= NEAR_BOTTOM_PX
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
    setAtTop((prev) => (prev === top ? prev : top))
    setAtBottom((prev) => (prev === bottom ? prev : bottom))
  }, [])

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
    measureEdges(el)
  }, [measureEdges])

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
    const opened = lastSessionRef.current !== transcript.sessionId
    if (opened) {
      lastSessionRef.current = transcript.sessionId
      nearBottomRef.current = true
    }
    if (opened || nearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
    measureEdges(el)
    if (!opened) return
    // On open, KEEP re-asserting the bottom for the next frames: the content height changes AFTER this
    // first pin — tool results clamp to 12 lines via ResizeObserver, and the window grows in the
    // background — so a one-shot pin gets stranded mid-history. Re-snap each frame (cheap; a no-op once
    // we're already at the bottom) until the height holds steady for a few frames or we hit the cap.
    // Bails immediately if the user scrolls up (nearBottomRef flips in handleScroll).
    if (repinRafRef.current != null) cancelAnimationFrame(repinRafRef.current)
    let frames = 0
    let lastHeight = el.scrollHeight
    let stable = 0
    const repin = (): void => {
      const node = scrollElRef.current
      if (!node || !nearBottomRef.current) {
        repinRafRef.current = null
        return
      }
      node.scrollTop = node.scrollHeight
      const h = node.scrollHeight
      stable = h === lastHeight ? stable + 1 : 0
      lastHeight = h
      frames += 1
      if (frames < 40 && stable < 5) {
        repinRafRef.current = requestAnimationFrame(repin)
      } else {
        repinRafRef.current = null
        measureEdges(node)
      }
    }
    repinRafRef.current = requestAnimationFrame(repin)
    return () => {
      if (repinRafRef.current != null) cancelAnimationFrame(repinRafRef.current)
    }
  }, [transcript, measureEdges])

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

  const total = groups.length
  const searching = searchQuery.trim().length > 0
  // Reset the window when the conversation changes (render-phase, guarded so it converges next render).
  const winSessionRef = useRef<string | null>(null)
  if (transcript && winSessionRef.current !== transcript.sessionId) {
    winSessionRef.current = transcript.sessionId
    setVisibleCount(WINDOW)
  }
  // Grow the window toward the full set, one idle chunk at a time — requestIdleCallback pauses the
  // catch-up while the user is scrolling/typing, so it never competes with interaction.
  useEffect(() => {
    if (!transcript || visibleCount >= total) return
    const grow = (): void => {
      const el = scrollElRef.current
      if (el) growHeightRef.current = el.scrollHeight
      setVisibleCount((c) => Math.min(total, c + GROW_STEP))
    }
    const handle = requestIdleCallback(grow, { timeout: 500 })
    return () => cancelIdleCallback(handle)
  }, [transcript, visibleCount, total])
  // A search must reach matches in older messages, so mount everything while searching — and leave it
  // mounted (bump visibleCount, don't just override the slice) so clearing the search doesn't shrink
  // the list back and yank the scroll position.
  useEffect(() => {
    if (searching && visibleCount < total) setVisibleCount(total)
  }, [searching, visibleCount, total])
  // After a grow (or a jump-to-top that forced a full mount) keep the viewport stable: honor a pending
  // jump-to-top once everything is mounted, else add the prepended height back so nothing visibly jumps.
  useLayoutEffect(() => {
    const el = scrollElRef.current
    if (!el) return
    if (pendingTopRef.current && visibleCount >= total) {
      pendingTopRef.current = false
      growHeightRef.current = null
      el.scrollTop = 0
      measureEdges(el)
      return
    }
    const prev = growHeightRef.current
    if (prev == null) return
    growHeightRef.current = null
    if (nearBottomRef.current) {
      // The common open / read-latest case: stay pinned to the TRUE bottom no matter what grew above,
      // so opening a long conversation snaps straight to the latest message (no drift, no scroll).
      el.scrollTop = el.scrollHeight
    } else {
      // Scrolled up reading history: add back exactly the prepended height so the view holds still.
      const delta = el.scrollHeight - prev
      if (delta > 0) el.scrollTop += delta
    }
    measureEdges(el)
  }, [visibleCount, total, measureEdges])

  if (loading && !transcript) {
    return (
      <div className="transcript-wrap">
        <div className="transcript-scroll sb-autoscroll" ref={attachScroll} tabIndex={-1}>
          <div className="transcript-content">
            <LoadingState />
          </div>
        </div>
      </div>
    )
  }

  if (!transcript) return null

  const count = transcript.messages.length
  // The windowed tail to render (full set while searching — see the effect above). dividerBefore is
  // computed against the absolute index into `groups`, so slicing never breaks the You↔non-You rule.
  const start = Math.max(0, total - (searching ? total : visibleCount))
  const visibleGroups = start > 0 ? groups.slice(start) : groups
  const jumpToEdge = (toTop: boolean): void => {
    const el = scrollElRef.current
    if (!el) return
    // Jump-to-top needs the whole transcript mounted first (the window may hold only the tail): flag it
    // and let the layout effect scroll to the true top once the grow-to-full completes.
    if (toTop && visibleCount < total) {
      pendingTopRef.current = true
      setVisibleCount(total)
      return
    }
    // Instant snap — no scroll animation (the layout effect handles the pending jump-to-top once the
    // full transcript has mounted).
    el.scrollTop = toTop ? 0 : el.scrollHeight
  }

  return (
    <div className="transcript-wrap">
      <div className="transcript-scroll sb-autoscroll" ref={attachScroll} tabIndex={-1}>
        <div className="transcript-content" ref={contentRef}>
          {visibleGroups.map((group, j) => {
            const idx = start + j
            return (
              <MessageBlock
                key={group.key}
                group={group}
                dividerBefore={idx > 0 && isHumanGroup(group) !== isHumanGroup(groups[idx - 1])}
              />
            )
          })}
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
      {/* Floating jump-to-edge pills — each shown only when scrolled away from THAT edge, anchored to
          its own edge (top pill up top, bottom pill at the bottom), center-aligned. pointer-events are
          re-enabled per-button so the wrapper never blocks scroll/selection. */}
      {!atTop ? (
        <div className="transcript-jump transcript-jump-top">
          <button
            type="button"
            className="transcript-jump-btn"
            aria-label="Jump to top"
            onClick={() => jumpToEdge(true)}
          >
            Jump to top
            <Arrow size={14} />
          </button>
        </div>
      ) : null}
      {!atBottom ? (
        <div className="transcript-jump transcript-jump-bottom">
          <button
            type="button"
            className="transcript-jump-btn"
            aria-label="Jump to bottom"
            onClick={() => jumpToEdge(false)}
          >
            Jump to bottom
            <Arrow size={14} className="transcript-jump-arrow-down" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
