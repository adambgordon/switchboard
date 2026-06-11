import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Tip {
  text: string
  /** Viewport x of the host's horizontal center. */
  x: number
  /** Viewport y the label anchors to (its top when below, its bottom when above). */
  y: number
  placement: 'top' | 'bottom'
  /** Host opted into a wrapping, max-width label (for paragraph-length copy) via `data-tip-wide`. */
  wide: boolean
}

const SHOW_DELAY = 450
const GAP = 7
const EDGE = 8

/**
 * App-wide tooltips. One fixed-positioned label driven by `data-tip` attributes anywhere in the
 * tree — the replacement for native `title`, which lags ~1s and resets on the slightest pointer
 * move (so it rarely showed). Delegated off document mouseover/out, so any element opts in with a
 * single `data-tip`; fixed positioning escapes scroll/overflow containers (the rail list, the
 * modal), flips above when there's no room below, and clamps to the viewport near the edges.
 * Ink-on-paper — never an accent, per the two-color invariant.
 */
export default function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const elRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const activeRef = useRef<Element | null>(null)

  useEffect(() => {
    const hide = (): void => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = undefined
      activeRef.current = null
      setTip(null)
    }
    const reveal = (el: Element): void => {
      const text = el.getAttribute('data-tip')
      if (!text) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom > 60
      setTip({
        text,
        x: r.left + r.width / 2,
        y: below ? r.bottom + GAP : r.top - GAP,
        placement: below ? 'bottom' : 'top',
        wide: el.hasAttribute('data-tip-wide')
      })
    }
    const onOver = (e: MouseEvent): void => {
      const el = (e.target as Element | null)?.closest('[data-tip]') ?? null
      if (!el || el === activeRef.current) return
      activeRef.current = el
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => reveal(el), SHOW_DELAY)
    }
    const onOut = (e: MouseEvent): void => {
      if (!activeRef.current) return
      // Ignore moves that stay within the active host (e.g. onto its child icon).
      const to = (e.relatedTarget as Element | null)?.closest('[data-tip]') ?? null
      if (to === activeRef.current) return
      hide()
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    // Any click, scroll, or window blur dismisses immediately — a stale tooltip is worse than none.
    document.addEventListener('mousedown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('mousedown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  // Keep the label inside the viewport horizontally (it's centered on the host by default).
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el || !tip) return
    el.style.left = `${tip.x}px`
    const r = el.getBoundingClientRect()
    let shift = 0
    if (r.left < EDGE) shift = EDGE - r.left
    else if (r.right > window.innerWidth - EDGE) shift = window.innerWidth - EDGE - r.right
    if (shift !== 0) el.style.left = `${tip.x + shift}px`
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={elRef}
      className={`sb-tip sb-tip-${tip.placement}${tip.wide ? ' sb-tip-wide' : ''}`}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      {tip.text}
    </div>
  )
}
