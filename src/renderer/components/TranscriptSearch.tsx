import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Search, Close, Chevron } from './icons'

interface Props {
  query: string
  /** Bumped by App on each ⌘F while focus is in the main pane; re-focuses + selects the input
   *  even when the bar is already open. */
  focusReq: number
  /** Total match count for the current query (0 when none / empty query). */
  count: number
  /** Zero-based index of the active match. */
  activeIndex: number
  onQueryChange: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

/**
 * The find-in-conversation bar — a floating widget over the main pane (not the rail's
 * cross-conversation search). ⏎ steps to the next match, ⇧⏎ to the previous, Esc closes;
 * those keys are handled here and `stopPropagation`'d so App's window-level shortcuts don't
 * also fire while you're typing in the field. Ink/graphite only — the two-accent invariant
 * reserves cobalt for liveness and red for destructive.
 */
export default function TranscriptSearch({
  query,
  focusReq,
  count,
  activeIndex,
  onQueryChange,
  onNext,
  onPrev,
  onClose
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus + select on mount AND whenever App bumps focusReq (a ⌘F with focus in the main pane) —
  // so pressing ⌘F again after clicking into the transcript re-focuses the field, not just the
  // first open. (On mount the effect fires with the initial focusReq, covering the open case too.)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusReq])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) onPrev()
      else onNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const hasQuery = query.trim().length > 0
  const readout = !hasQuery ? '' : count === 0 ? 'No results' : `${activeIndex + 1} / ${count}`
  const noMatches = count === 0

  return (
    <div className="sb-find" role="search">
      <Search size={13} className="sb-find-icon" />
      <input
        ref={inputRef}
        className="sb-find-input"
        placeholder="Find in conversation"
        value={query}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        aria-label="Find in conversation"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="sb-find-count mono">{readout}</span>
      <button
        className="sb-find-nav"
        onClick={onPrev}
        disabled={noMatches}
        data-tip="Previous match (⇧⏎)"
        aria-label="Previous match"
      >
        <Chevron size={14} className="sb-find-up" />
      </button>
      <button
        className="sb-find-nav"
        onClick={onNext}
        disabled={noMatches}
        data-tip="Next match (⏎)"
        aria-label="Next match"
      >
        <Chevron size={14} />
      </button>
      <button className="sb-find-close" onClick={onClose} data-tip="Close (Esc)" aria-label="Close find">
        <Close size={14} />
      </button>
    </div>
  )
}
