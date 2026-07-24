import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import type { Transcript } from '@shared/types'
import CopyButton from './CopyButton'
import MessageBlock from './MessageBlock'
import { Arrow } from './icons'
import { conversationMarkdown } from '../lib/clipboard'
import { buildTranscript, type TranscriptItem } from '../lib/messageGroups'
import { attachAutoHide } from '../lib/useAutoHideScrollbar'
import { useTranscriptSearch } from '../lib/useTranscriptSearch'

const NOOP = (): void => {}

/** A "You" (human) section — the divider separates these from the agent sections. */
const isHumanItem = (item: TranscriptItem): boolean => item.kind === 'section' && !item.isAssistant

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

/** Render-windowing: mount only the last WINDOW groups on open — keeps first paint of a long transcript
 *  instant (the dominant cost is mounting each group's ReactMarkdown, so capping the initial mount is
 *  what makes it feel instant). Older groups mount on demand: GROW_STEP at a time as the user scrolls
 *  up (handleScroll, reverse infinite-scroll), or all at once for search / jump-to-top. */
const WINDOW = 60
const GROW_STEP = 120
// Reverse infinite-scroll: start mounting the next-older chunk once the user scrolls within this many
// px of the top, so it's in place before they reach it. Replaces the old eager idle-grow, which
// prepended while pinned to the bottom and caused the open-time shake.
const GROW_TRIGGER_PX = 1500

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
  // Last observed scrollTop. Lets handleScroll tell a user's upward scroll (scrollTop DECREASES) apart
  // from content growing beneath a pinned viewport (scrollTop UNCHANGED) — see handleScroll. Every
  // programmatic scroll write updates this so our own writes are never mistaken for a user gesture.
  const lastTopRef = useRef(0)
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
  // Reverse infinite-scroll bookkeeping. The refs mirror render values so the stable scroll handler can
  // read them without re-binding; growPendingRef gates one chunk per approach (cleared once the
  // compensation effect has applied the prepend).
  const visibleCountRef = useRef(WINDOW)
  const totalRef = useRef(0)
  const searchingRef = useRef(false)
  const growPendingRef = useRef(false)
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
    const top = el.scrollTop
    const dist = el.scrollHeight - top - el.clientHeight
    const prev = lastTopRef.current
    lastTopRef.current = top
    if (nearBottomRef.current) {
      // Pinned to the bottom. A gap to the bottom can open for two very different reasons:
      //  • the user scrolled UP — scrollTop DECREASES — which releases the pin; vs
      //  • content GREW beneath a fixed scrollTop (tool results clamping, the window growing) —
      //    scrollTop is UNCHANGED — which must NOT release it.
      // Mistaking the latter for the former was the large-conversation bug: a single >NEAR_BOTTOM_PX
      // post-pin height settle latched near=false and stranded the view mid-history. So only an actual
      // decrease releases the pin; an unchanged scrollTop with a gap means re-assert the bottom.
      if (top < prev - 0.5) {
        nearBottomRef.current = false
      } else if (dist >= NEAR_BOTTOM_PX) {
        el.scrollTop = el.scrollHeight
        lastTopRef.current = el.scrollTop
      }
    } else if (dist < NEAR_BOTTOM_PX) {
      // Scrolled back down into the bottom band → resume sticking to the latest.
      nearBottomRef.current = true
    }
    // Reverse infinite-scroll: mount the next-older chunk as the user nears the top. Gated to AFTER
    // they've scrolled up off the bottom (never the initial pinned open — that was the eager-grow
    // shake), one chunk at a time. The compensation effect preserves position on the prepend.
    if (
      !nearBottomRef.current &&
      !searchingRef.current &&
      !growPendingRef.current &&
      visibleCountRef.current < totalRef.current &&
      top < GROW_TRIGGER_PX
    ) {
      growPendingRef.current = true
      growHeightRef.current = el.scrollHeight
      setVisibleCount((c) => Math.min(totalRef.current, c + GROW_STEP))
    }
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
      lastTopRef.current = el.scrollTop
    }
    measureEdges(el)
    if (!opened) return
    // On open, KEEP re-asserting the bottom for the next frames: the content height changes AFTER this
    // first pin (tool results measuring overflow + adding "Expand" via ResizeObserver), so a one-shot
    // pin can get stranded. Re-snap each frame (cheap; a no-op once we're already at the bottom) until
    // the height holds steady for a few frames or we hit the cap. Bails immediately if the user scrolls
    // up (nearBottomRef flips in handleScroll). The content ResizeObserver below also covers later
    // settles; this rAF loop covers the first frames.
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
      lastTopRef.current = node.scrollTop
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

  // Build the ordered render items — same-author sections, each bundling that author's prose beats +
  // tool runs under one header. Memoized on the transcript so search-driven re-renders reuse the same
  // item objects and MessageBlock's memo holds.
  const items = useMemo(
    () => (transcript ? buildTranscript(transcript.messages, transcript.agent) : []),
    [transcript]
  )

  const total = items.length
  const searching = searchQuery.trim().length > 0
  // Mirror render values into refs for the stable scroll handler (reverse infinite-scroll trigger).
  visibleCountRef.current = visibleCount
  totalRef.current = total
  searchingRef.current = searching
  // Reset the window when the conversation changes (render-phase, guarded so it converges next render).
  const winSessionRef = useRef<string | null>(null)
  if (transcript && winSessionRef.current !== transcript.sessionId) {
    winSessionRef.current = transcript.sessionId
    setVisibleCount(WINDOW)
    // Drop any pending scroll-grow bookkeeping from the previous conversation.
    growPendingRef.current = false
    growHeightRef.current = null
  }
  // The window grows ON SCROLL-UP now (handleScroll), not eagerly: eager idle-grow prepended chunks
  // while pinned to the bottom, and chasing the bottom through each prepend produced the open-time
  // shake. Search and jump-to-top still force a full mount on demand (effects below / jumpToEdge).
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
      lastTopRef.current = el.scrollTop
      measureEdges(el)
      return
    }
    const prev = growHeightRef.current
    if (prev == null) return
    growHeightRef.current = null
    growPendingRef.current = false // chunk mounted + about to be position-compensated; allow the next
    if (nearBottomRef.current) {
      // The common open / read-latest case: stay pinned to the TRUE bottom no matter what grew above,
      // so opening a long conversation snaps straight to the latest message (no drift, no scroll).
      el.scrollTop = el.scrollHeight
      lastTopRef.current = el.scrollTop
    } else {
      // Scrolled up reading history: add back exactly the prepended height so the view holds still.
      const delta = el.scrollHeight - prev
      if (delta > 0) el.scrollTop += delta
      lastTopRef.current = el.scrollTop
    }
    measureEdges(el)
  }, [visibleCount, total, measureEdges])

  // Keep the bottom pinned through ASYNC content-height changes while pinned — a tool-result's
  // "Expand" affordance settling in via its own ResizeObserver, font/markdown reflow — that don't
  // flow through the grow/compensation path. A ResizeObserver fires after layout but BEFORE paint, so
  // re-pinning here corrects the change in the same frame, no flash. Only while pinned (near bottom);
  // scrolled-up history reading is the compensation effect's job and must not be yanked down.
  useEffect(() => {
    const content = contentRef.current
    const el = scrollElRef.current
    if (!content || !el) return
    const ro = new ResizeObserver(() => {
      if (!nearBottomRef.current) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 1) return
      el.scrollTop = el.scrollHeight
      lastTopRef.current = el.scrollTop
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [transcript])

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
  // computed against the absolute index into `items`, so slicing never breaks the You↔non-You rule.
  const start = Math.max(0, total - (searching ? total : visibleCount))
  const visibleItems = start > 0 ? items.slice(start) : items
  const jumpToEdge = (toTop: boolean): void => {
    const el = scrollElRef.current
    if (!el) return
    // A jump is an explicit pin choice. Jumping to the TOP must release the bottom-stick: otherwise the
    // scroll handler, still pinned, reads the resulting gap to the bottom as content-grew-beneath and
    // snaps right back down (the jump only "worked" once you'd scrolled up first, which already cleared
    // the stick). Jumping to the BOTTOM resumes sticking.
    nearBottomRef.current = !toTop
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
    lastTopRef.current = el.scrollTop
  }

  return (
    <div className="transcript-wrap">
      <div className="transcript-scroll sb-autoscroll" ref={attachScroll} tabIndex={-1}>
        <div className="transcript-content" ref={contentRef}>
          {visibleItems.map((item, j) => {
            const idx = start + j
            return (
              <MessageBlock
                key={item.key}
                item={item}
                dividerBefore={idx > 0 && isHumanItem(item) !== isHumanItem(items[idx - 1])}
              />
            )
          })}
          {count > 0 ? (
            <footer className="transcript-foot">
              <span className="transcript-foot-rule" aria-hidden="true" />
              <span className="transcript-foot-meta">
                <span className="transcript-foot-label label-caps">
                  End of transcript · {count} {count === 1 ? 'message' : 'messages'}
                </span>
                <span className="transcript-foot-copy-tip" data-tip="Copy entire conversation">
                  <CopyButton
                    className="transcript-copy"
                    tip="Copy entire conversation"
                    getText={() => conversationMarkdown(transcript.messages, transcript.agent)}
                  />
                </span>
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
