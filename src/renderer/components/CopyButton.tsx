import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Check, Copy } from './icons'

/**
 * Copy affordance — a hover-revealed icon button that flashes a check for ~700ms on click (the
 * TallyRail.copySessionId pattern). Neutral ink only (copy isn't an accent action). `getText` is
 * read lazily on click, so callers pull from a ref / the DOM / props at that moment.
 *
 * Shared by the transcript's per-block / per-turn copies (MessageBlock) and the conversation-info
 * modal's session-id copy. Styling is `.copy-btn` (+ any `className`) in transcript.css; the base
 * is `opacity:0`, so a host that wants it always/hover-visible supplies the reveal rule.
 */
export default function CopyButton({
  getText,
  className,
  tip = 'Copy'
}: {
  getText: () => string
  className?: string
  tip?: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onClick = (e: ReactMouseEvent): void => {
    // Never toggle a surrounding <details>, start a text selection, or bubble to the pane.
    e.preventDefault()
    e.stopPropagation()
    const text = getText()
    if (!text) return
    void navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 700)
  }
  return (
    <button
      type="button"
      className={`copy-btn${className ? ' ' + className : ''}${copied ? ' copied' : ''}`}
      onClick={onClick}
      aria-label={tip}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}
