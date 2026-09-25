import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampTipText, placeTip, placeTipRight, tipMetaLine, tipOnEnter, tipOnLeave, type TipTarget } from '../lib/tooltip'

interface Tip {
  text: string
  /** Optional supporting line beneath the title, from `data-tip-sub`. Null when the host has none. */
  sub: string | null
  /** Optional quiet third line — `data-tip-at` (a last-activity timestamp, aged at reveal) and
   *  `data-tip-meta`, joined. Null when the host has neither. */
  meta: string | null
  /** Viewport x of the host's horizontal center. */
  x: number
  /** Viewport y of the host's top edge. */
  hostTop: number
  /** Viewport y of the host's bottom edge. */
  hostBottom: number
  /** Viewport x of the host's right edge. */
  hostRight: number
  /** A scrub host (`data-tip-scrub`): the label sits to its right, and sweeping across such hosts
   *  re-fills it. */
  scrub: boolean
  /** Re-filled from a neighboring scrub host rather than freshly shown — the label glides to its new
   *  place instead of appearing there. */
  glide: boolean
  /** Host opted into a wrapping, max-width label (for paragraph-length copy) via `data-tip-wide`. */
  wide: boolean
  /** Host opted into the tighter padding variant via `data-tip-compact`. */
  compact: boolean
}

const SHOW_DELAY = 450
/** How long a scrub-host label outlives its host while the pointer crosses a gap between hosts. */
const SCRUB_GRACE = 150
const GAP = 7
const EDGE = 8

/** The tooltip host an element belongs to. A scrub host wins over a host nested inside it, so a
 *  sweep down the rail is not interrupted by each row's logo carrying a label of its own. */
function hostOf(t: EventTarget | null): Element | null {
  const el = t instanceof Element ? t : null
  return el?.closest('[data-tip-scrub]') ?? el?.closest('[data-tip]') ?? null
}

const targetOf = (host: Element | null): TipTarget =>
  host === null ? 'none' : host.hasAttribute('data-tip-scrub') ? 'scrub' : 'plain'

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
  const graceTimer = useRef<ReturnType<typeof setTimeout>>()
  // A scrub host's label is on screen (possibly within its grace) — what makes the next one instant.
  const scrubShownRef = useRef(false)

  useEffect(() => {
    const clearGrace = (): void => {
      if (graceTimer.current) clearTimeout(graceTimer.current)
      graceTimer.current = undefined
    }
    const hide = (): void => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = undefined
      clearGrace()
      activeRef.current = null
      scrubShownRef.current = false
      setTip(null)
    }
    const reveal = (el: Element, glide: boolean): void => {
      const text = el.getAttribute('data-tip')
      if (!text) return
      const r = el.getBoundingClientRect()
      const sub = el.getAttribute('data-tip-sub')
      // Preferences copy is never truncated. The clamp exists for strings the app does not author and
      // cannot bound — a link's tip is its raw href, a row's is a conversation title — where losing
      // the middle is the lesser harm. Every tooltip in Preferences is prose written to be read, and
      // cutting it mid-sentence produced exactly the nonsense the clamp is meant to prevent
      // ("starting another recl…s is intended to prevent").
      //
      // Scoped by CONTAINER, not by an opt-in attribute, and deliberately so: the failure being fixed
      // is that authored copy got truncated at all, and an attribute someone must remember to add
      // reintroduces it for the next setting written. `data-tip-wide` is NOT the signal here — a
      // markdown link carries it alongside a thousand-character href (see MessageBlock), which is the
      // case the clamp most needs to keep.
      //
      // Safe without a length bound because placement already has one: `placeTip` measures the
      // rendered label and clamps it into the viewport, so over-long copy is pinned at the top edge
      // rather than breaking the layout.
      //
      // The rail's list and the tab strip are exempt too, for a different reason: they carry prose the
      // app does not author — titles, previews — but that is read from the start, so each END-clamps
      // its fields to their own budgets before they get here (see rowTip). A middle-cut would splice
      // two halves of a sentence together. The rail's head is not exempt: the new-conversation
      // chooser's paths are exactly what the middle-cut is for.
      const unclamped = !!el.closest('.sb-modal-settings, .sb-rail-body, .sb-tabstrip')
      const clamp = (s: string): string => (unclamped ? s : clampTipText(s))
      const at = Number(el.getAttribute('data-tip-at'))
      const meta = tipMetaLine(
        el.hasAttribute('data-tip-at') && Number.isFinite(at) ? at : null,
        el.getAttribute('data-tip-meta'),
        Date.now()
      )
      setTip({
        text: clamp(text),
        // Clamped by the same rule as the title: the label must be bounded by what it renders, not by
        // what its current callers happen to pass.
        sub: sub ? clamp(sub) : null,
        meta: meta ? clamp(meta) : null,
        x: r.left + r.width / 2,
        hostTop: r.top,
        hostBottom: r.bottom,
        hostRight: r.right,
        scrub: el.hasAttribute('data-tip-scrub'),
        glide,
        wide: el.hasAttribute('data-tip-wide'),
        compact: el.hasAttribute('data-tip-compact')
      })
    }
    const onOver = (e: MouseEvent): void => {
      // Never while a button is held. A drag sweeps the pointer across the whole window, so every
      // `data-tip` host it passes would arm a tooltip — and one duly appeared over a tab being
      // dragged, describing a conversation the user was in the middle of moving. Stated as "no
      // tooltips during any drag" rather than as a check for this particular one: a label explaining
      // what is under the pointer is meaningless while the pointer is carrying something.
      if (e.buttons !== 0) return
      const el = hostOf(e.target)
      if (!el || el === activeRef.current) return
      clearGrace()
      const next = tipOnEnter(scrubShownRef.current, targetOf(el) === 'scrub' ? 'scrub' : 'plain')
      if (next === 'replace') hide()
      activeRef.current = el
      if (timer.current) clearTimeout(timer.current)
      if (next === 'refill') {
        timer.current = undefined
        reveal(el, true)
      } else {
        timer.current = setTimeout(() => reveal(el, false), SHOW_DELAY)
      }
    }
    const onOut = (e: MouseEvent): void => {
      if (!activeRef.current) return
      // Ignore moves that stay within the active host (e.g. onto its child icon).
      const to = hostOf(e.relatedTarget)
      if (to === activeRef.current) return
      const next = tipOnLeave(scrubShownRef.current, targetOf(to))
      if (next === 'hide') return hide()
      // Keep the label up: the host being entered re-fills it, or the grace ends it.
      activeRef.current = null
      if (next === 'grace') graceTimer.current = setTimeout(hide, SCRUB_GRACE)
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
      clearGrace()
    }
  }, [])

  // Place the label now that it can be measured — vertical side + clamp, then the horizontal clamp.
  // Done imperatively in ONE layout effect (rather than by feeding a measurement back into state) so
  // there is no second render between measuring and placing, and so nothing paints mis-positioned.
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el || !tip) return
    scrubShownRef.current = tip.scrub

    if (tip.scrub) {
      const { left, top } = placeTipRight({
        hostTop: tip.hostTop,
        hostBottom: tip.hostBottom,
        hostRight: tip.hostRight,
        width: el.offsetWidth,
        height: el.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        gap: GAP,
        edge: EDGE
      })
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      el.style.transform = 'none'
      return
    }

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
      className={`sb-tip${tip.wide ? ' sb-tip-wide' : ''}${tip.compact ? ' sb-tip-compact' : ''}${tip.glide ? ' sb-tip-glide' : ''}`}
      // A first guess only, so the label never paints at the viewport origin; the layout effect above
      // overwrites all three before paint.
      style={
        tip.scrub
          ? { left: tip.hostRight + GAP, top: tip.hostTop, transform: 'none' }
          : { left: tip.x, top: tip.hostBottom + GAP, transform: 'translate(-50%, 0)' }
      }
      role="tooltip"
    >
      {tip.sub || tip.meta ? (
        <>
          <div className="sb-tip-title">{tip.text}</div>
          {tip.sub && <div className="sb-tip-sub">{tip.sub}</div>}
          {tip.meta && <div className="sb-tip-meta">{tip.meta}</div>}
        </>
      ) : (
        tip.text
      )}
    </div>
  )
}
