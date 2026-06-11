import { useEffect, useRef, type RefObject } from 'react'
import { findMatches } from './findMatches'

/** Highlight registry names: all matches, and the single active one (painted stronger). */
const HL_ALL = 'sb-find'
const HL_CURRENT = 'sb-find-current'

/** The CSS Custom Highlight API (Chromium 105+, so present in Electron 42) — feature-detected
 *  so an older engine degrades to count + scroll without painted highlights, rather than throwing. */
const HAS_HIGHLIGHT_API =
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'

interface Params {
  /** The `.transcript-content` element to search within (the rendered message column). */
  contentRef: RefObject<HTMLElement | null>
  /** The `.transcript-scroll` container, used to bring the active match into view. */
  scrollRef: RefObject<HTMLElement | null>
  /** The (already debounced/deferred) query. Empty or whitespace clears the search. */
  query: string
  /** Index of the active match; clamped here against the live match count. */
  activeIndex: number
  /** Changes whenever the transcript content changes, so matches are rebuilt for live sessions. */
  revision: string
  /** Reports the match count up to the owner (drives the n/total readout + clamping). */
  onCount: (n: number) => void
}

/** Walk the text nodes under `root` and build a DOM Range for every substring match. Skips only
 *  transcript chrome (end-of-transcript footer, loading skeleton); collapsed sections (closed tool
 *  `<details>`, clamped result tails) ARE included so their matches can be navigated to + revealed. */
function collectRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('.transcript-foot, .transcript-loading')) {
        return NodeFilter.FILTER_REJECT
      }
      const text = node.nodeValue
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    for (const [start, end] of findMatches(text, query)) {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      ranges.push(range)
    }
  }
  return ranges
}

function clearHighlights(): void {
  if (!HAS_HIGHLIGHT_API) return
  CSS.highlights.delete(HL_ALL)
  CSS.highlights.delete(HL_CURRENT)
}

/** Scroll `range` to a comfortable position inside `scroll` if it's outside the viewport. */
function scrollRangeIntoView(range: Range, scroll: HTMLElement | null): void {
  if (!scroll) return
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return // collapsed / not rendered
  const view = scroll.getBoundingClientRect()
  const margin = 80 // keep the match off the very edge of the pane
  if (rect.top < view.top + margin) {
    scroll.scrollTop -= view.top + margin - rect.top
  } else if (rect.bottom > view.bottom - margin) {
    scroll.scrollTop += rect.bottom - (view.bottom - margin)
  }
}

/**
 * If the active match sits inside a collapsed section, reveal it so the highlight is visible: a
 * closed tool `<details>` is opened directly (native + uncontrolled, so the change sticks), and a
 * clamped tool result is expanded by asking its React component via an `sb-reveal` event. Returns
 * true when a React-driven expand was requested, so the caller defers the scroll one frame (the
 * re-render + relayout hasn't happened yet).
 */
function revealContainer(range: Range): boolean {
  const start = range.startContainer
  const el = start instanceof Element ? start : start.parentElement
  if (!el) return false
  const details = el.closest('details:not([open])')
  if (details instanceof HTMLDetailsElement) details.open = true
  const clamped = el.closest('.tool-result-clip.is-clamped')
  if (clamped) {
    clamped.dispatchEvent(new CustomEvent('sb-reveal'))
    return true
  }
  return false
}

/**
 * Find-in-conversation engine for the Formatted transcript. Walks the rendered text nodes under
 * `contentRef`, builds Ranges for each case-insensitive substring match, and paints them with the
 * CSS Custom Highlight API — **no DOM mutation**, so it never fights react-markdown's element tree
 * or defeats `MessageBlock`'s `memo` (snappiness-first). The active match gets a second, stronger
 * highlight and is scrolled into view. Matches rebuild when the query or transcript content changes.
 *
 * Coverage includes collapsed sections: matches inside closed tool `<details>` and the clamped tail
 * of long tool results ARE found, and navigating to one reveals its section (opens the details /
 * expands the result) before scrolling it into view. Only transcript chrome (footer, loading
 * skeleton) is excluded. Matches are found within a single text node, so a phrase spanning element
 * boundaries (e.g. across a bold run) won't match — a deliberate Phase-1 limitation.
 */
export function useTranscriptSearch({
  contentRef,
  scrollRef,
  query,
  activeIndex,
  revision,
  onCount
}: Params): void {
  const rangesRef = useRef<Range[]>([])
  // Hold onCount in a ref so an inline callback identity doesn't re-run the (expensive) find effect.
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount

  // Rebuild matches when the query or the transcript content changes. Runs after paint (a plain
  // effect, not layout) so a long walk never blocks the keystroke's frame.
  useEffect(() => {
    const root = contentRef.current
    if (!root || !query.trim()) {
      rangesRef.current = []
      clearHighlights()
      onCountRef.current(0)
      return
    }
    const ranges = collectRanges(root, query)
    rangesRef.current = ranges
    if (HAS_HIGHLIGHT_API) {
      if (ranges.length) {
        const hl = new Highlight()
        for (const r of ranges) hl.add(r)
        CSS.highlights.set(HL_ALL, hl)
      } else {
        CSS.highlights.delete(HL_ALL)
      }
    }
    onCountRef.current(ranges.length)
  }, [contentRef, query, revision])

  // Paint the active match distinctly and bring it into view. Re-runs on active-index changes
  // (next/prev) as well as query/revision — reading the ranges the effect above just built.
  useEffect(() => {
    const ranges = rangesRef.current
    if (!ranges.length) {
      if (HAS_HIGHLIGHT_API) CSS.highlights.delete(HL_CURRENT)
      return
    }
    const i = Math.max(0, Math.min(activeIndex, ranges.length - 1))
    const range = ranges[i]
    // Reveal the active match first if it's inside a collapsed section, so the highlight is visible.
    const deferred = revealContainer(range)
    if (HAS_HIGHLIGHT_API) {
      const hl = new Highlight()
      hl.add(range)
      CSS.highlights.set(HL_CURRENT, hl)
    }
    // A native <details> opens synchronously → scroll now; a clamped result expands via a React
    // re-render → wait one frame for the relayout before scrolling to the (now visible) match.
    if (!deferred) {
      scrollRangeIntoView(range, scrollRef.current)
      return
    }
    const raf = requestAnimationFrame(() => scrollRangeIntoView(range, scrollRef.current))
    return () => cancelAnimationFrame(raf)
  }, [activeIndex, query, revision, scrollRef])

  // Drop highlights when the consumer unmounts (e.g. switching away from the transcript).
  useEffect(() => () => clearHighlights(), [])
}
