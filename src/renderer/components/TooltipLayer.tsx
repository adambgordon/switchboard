import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampTipText, placeTip } from '../lib/tooltip'

interface Tip {
  text: string
  /** Viewport x of the host's horizontal center. */
  x: number
  /** Viewport y of the host's top edge. */
  hostTop: number
  /** Viewport y of the host's bottom edge. */
  hostBottom: number
  /** Host opted into a wrapping, max-width label (for paragraph-length copy) via `data-tip-wide`. */
  wide: boolean
  /** Host opted into the tighter padding variant via `data-tip-compact`. */
  compact: boolean
}

const SHOW_DELAY = 450
const GAP = 7
const EDGE = 8

/**
 * App-wide tooltips. One fixed-positioned label driven by `data-tip` attributes anywhere in the
 * tree — the replacement for native `title`, which lags ~1s and resets on the slightest pointer
 * move (so it rarely showed). Delegated off document mouseover/out, so any element opts in with a
 * single `data-tip`; fixed positioning escapes scroll/overflow containers (the rail list, the modal).
 * Ink-on-paper — never an accent, per the two-color invariant.
 *
 * PLACEMENT HAPPENS AFTER MEASUREMENT, on both axes. `reveal` only records the host's rect; which side
 * the label takes and where it lands is decided in the layout effect below, once the label's real size
 * is known. A wrapped label can be twenty times the height of a one-liner, so any side chosen before
 * it exists is a guess — see `placeTip`.
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
      setTip({
        text: clampTipText(text),
        x: r.left + r.width / 2,
        hostTop: r.top,
        hostBottom: r.bottom,
        wide: el.hasAttribute('data-tip-wide'),
        compact: el.hasAttribute('data-tip-compact')
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

  // Place the label now that it can be measured — vertical side + clamp, then the horizontal clamp.
  // Done imperatively in ONE layout effect (rather than by feeding a measurement back into state) so
  // there is no second render between measuring and placing, and so nothing paints mis-positioned.
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el || !tip) return

    const { side, top } = placeTip({
      hostTop: tip.hostTop,
      hostBottom: tip.hostBottom,
      height: el.offsetHeight,
      viewport: window.innerHeight,
      gap: GAP,
      edge: EDGE
    })
    el.style.top = `${top}px`
    el.style.transform = side === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)'

    // Horizontal: centered on the host, shifted just enough to clear either edge.
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
      className={`sb-tip${tip.wide ? ' sb-tip-wide' : ''}${tip.compact ? ' sb-tip-compact' : ''}`}
      // A first guess only, so the label never paints at the viewport origin; the layout effect above
      // overwrites all three before paint.
      style={{ left: tip.x, top: tip.hostBottom + GAP, transform: 'translate(-50%, 0)' }}
      role="tooltip"
    >
      {tip.text}
    </div>
  )
}
