import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { heldKeys, onHeldKeys } from '../lib/heldKeys'
import {
  clampTipText,
  placeTip,
  placeTipRight,
  tipBoxLeft,
  tipMetaLine,
  tipMorph,
  tipOnEnter,
  tipOnLeave,
  type TipRect,
  type TipTarget
} from '../lib/tooltip'
import MetaText from './MetaText'

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
  /** A scrub host (`data-tip-scrub`), stacked in a column: the label sits to its right. */
  scrub: boolean
  /** The host's tooltip group (`data-tip-group`), or null: moving onto another host in it re-fills the
   *  label at once. */
  group: Element | null
  /** Host opted into a wrapping, max-width label (for paragraph-length copy) via `data-tip-wide`. */
  wide: boolean
  /** Host opted into the tighter padding variant via `data-tip-compact`. */
  compact: boolean
}

const SHOW_DELAY = 700
/** For hosts whose purpose is plain from their icon (`data-tip-slow`): the label is there for whoever
 *  lingers, and must not flash up under a pointer merely passing over — or resting on — them. */
const SLOW_SHOW_DELAY = 1500
/** How long a grouped label outlives its host once the pointer has left the group onto no host. */
const SCRUB_GRACE = 150
/** How long it outlives its host while the pointer crosses a gap INSIDE the group — a folder header
 *  between rail rows — so the next host can be reached at an unhurried pace. */
const GROUP_HOLD = 400
/** A label re-filled from a neighbor morphs from that neighbor's box to its own. Short enough that a
 *  sweep down the rail still reads each row at once, and eased at both ends so the box neither lurches
 *  off nor snaps into place. A sweep faster than this restarts the morph from wherever the box is. */
const MORPH: KeyframeAnimationOptions = { duration: 150, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
const GAP = 7
const EDGE = 8

/** The tooltip host an element belongs to. A scrub host wins over a host nested inside it, so a
 *  sweep down the rail is not interrupted by each row's logo carrying a label of its own. */
function hostOf(t: EventTarget | null): Element | null {
  const el = t instanceof Element ? t : null
  return el?.closest('[data-tip-scrub]') ?? el?.closest('[data-tip]') ?? null
}

const groupOf = (host: Element): Element | null => host.closest('[data-tip-group]')

const targetOf = (host: Element | null): TipTarget => (host === null ? null : { group: groupOf(host) })

/** A host's label under the modifiers held now: `data-tip-alt` while ⌥ is down, `data-tip-shift` while
 *  ⇧ is, for a control whose meaning changes under one (see heldKeys). */
function tipText(el: Element): string | null {
  const keys = heldKeys()
  return (
    (keys.alt ? el.getAttribute('data-tip-alt') : null) ??
    (keys.shift ? el.getAttribute('data-tip-shift') : null) ??
    el.getAttribute('data-tip')
  )
}

/**
 * App-wide tooltips. One fixed-positioned label driven by `data-tip` attributes anywhere in the
 * tree — used instead of native `title`, which lags ~1s and resets on the slightest pointer
 * move. Delegated off document mouseover/out, so any element opts in with a
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
  const bodyRef = useRef<HTMLDivElement>(null)
  // The box of the label a re-fill replaces, read as it stood on screen, before the new content renders.
  const morphFromRef = useRef<TipRect | null>(null)
  const morphRef = useRef<Animation | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const activeRef = useRef<Element | null>(null)
  const graceTimer = useRef<ReturnType<typeof setTimeout>>()
  // The group of the label on screen (possibly within its grace) — what makes its neighbors instant.
  const shownGroupRef = useRef<Element | null>(null)
  // The host whose label is on screen, so a modifier going down or up can re-word it in place.
  const shownHostRef = useRef<Element | null>(null)

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
      shownGroupRef.current = null
      shownHostRef.current = null
      setTip(null)
    }
    const reveal = (el: Element, refill: boolean): void => {
      const text = tipText(el)
      if (!text) return
      shownHostRef.current = el
      // Read here, while the outgoing label is still rendered — mid-morph included, since a running
      // animation is part of the rect.
      const shown = refill ? elRef.current?.getBoundingClientRect() : undefined
      morphFromRef.current = shown ? { left: shown.left, top: shown.top, width: shown.width, height: shown.height } : null
      const r = el.getBoundingClientRect()
      const sub = el.getAttribute('data-tip-sub')
      // Preferences copy is never truncated. The clamp exists for strings the app does not author and
      // cannot bound — a link's tip is its raw href, a row's is a conversation title — where losing
      // the middle is the lesser harm. Every tooltip in Preferences is prose written to be read, and
      // cutting it mid-sentence produces exactly the nonsense the clamp is meant to prevent.
      //
      // Scoped by CONTAINER, not by an opt-in attribute, and deliberately so: authored copy must
      // never be truncated, and an attribute someone must remember to add would leave the next
      // setting written unprotected. `data-tip-wide` is NOT the signal here — a
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
        group: groupOf(el),
        wide: el.hasAttribute('data-tip-wide'),
        compact: el.hasAttribute('data-tip-compact')
      })
    }
    const onOver = (e: MouseEvent): void => {
      // Never while a button is held. A drag sweeps the pointer across the whole window, so every
      // `data-tip` host it passes would arm a tooltip — over a dragged tab, one would describe the
      // conversation being moved. The rule is "no tooltips during any drag", not a check for any
      // one case: a label explaining what is under the pointer is meaningless while the pointer is
      // carrying something.
      if (e.buttons !== 0) return
      const el = hostOf(e.target)
      if (!el || el === activeRef.current) return
      clearGrace()
      const next = tipOnEnter(shownGroupRef.current, { group: groupOf(el) })
      if (next === 'replace') hide()
      activeRef.current = el
      if (timer.current) clearTimeout(timer.current)
      if (next === 'refill') {
        timer.current = undefined
        reveal(el, true)
      } else {
        const delay = el.hasAttribute('data-tip-slow') ? SLOW_SHOW_DELAY : SHOW_DELAY
        timer.current = setTimeout(() => reveal(el, false), delay)
      }
    }
    const onOut = (e: MouseEvent): void => {
      if (!activeRef.current) return
      // Ignore moves that stay within the active host (e.g. onto its child icon).
      const to = hostOf(e.relatedTarget)
      if (to === activeRef.current) return
      const group = shownGroupRef.current
      const inGroup = group !== null && e.relatedTarget instanceof Node && group.contains(e.relatedTarget)
      const next = tipOnLeave(group, targetOf(to), inGroup)
      if (next === 'hide') return hide()
      // Keep the label up: the host being entered re-fills it, or the grace ends it.
      activeRef.current = null
      if (next !== 'keep') graceTimer.current = setTimeout(hide, next === 'hold' ? GROUP_HOLD : SCRUB_GRACE)
    }
    // Pressing or releasing ⌥ / ⇧ over a control that means something else under it re-words its label
    // at once, where it stands.
    const offKeys = onHeldKeys(() => {
      const el = shownHostRef.current
      if (el && el === activeRef.current && (el.hasAttribute('data-tip-alt') || el.hasAttribute('data-tip-shift'))) {
        reveal(el, false)
      }
    })
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mouseout', onOut)
    // Any click, scroll, or window blur dismisses immediately — a stale tooltip is worse than none.
    document.addEventListener('mousedown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      offKeys()
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
      document.removeEventListener('mousedown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      if (timer.current) clearTimeout(timer.current)
      clearGrace()
    }
  }, [])

  // Place the label now that it can be measured — vertical side + clamp, then the horizontal clamp —
  // and, for a re-fill, morph it there from the label it replaces. Done imperatively in ONE layout
  // effect (rather than by feeding a measurement back into state) so there is no second render between
  // measuring and placing, and so nothing paints mis-positioned.
  //
  // The label is always placed by its top-left corner, with no anchoring transform: the morph compares
  // where the old box was with where the new one goes, so both must be the same kind of coordinate.
  useLayoutEffect(() => {
    const el = elRef.current
    const body = bodyRef.current
    if (!el || !body || !tip) return
    shownGroupRef.current = tip.group
    const from = morphFromRef.current
    morphFromRef.current = null

    // A morph still running would skew every measurement below. Its progress is not lost: `from` was
    // read with it applied.
    morphRef.current?.cancel()
    morphRef.current = null
    body.style.width = ''

    const width = el.offsetWidth
    const height = el.offsetHeight
    const { left, top } = tip.scrub
      ? placeTipRight({
          hostTop: tip.hostTop,
          hostBottom: tip.hostBottom,
          hostRight: tip.hostRight,
          width,
          height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          gap: GAP,
          edge: EDGE
        })
      : {
          left: tipBoxLeft(tip.x, width, window.innerWidth, EDGE),
          top: placeTip({
            hostTop: tip.hostTop,
            hostBottom: tip.hostBottom,
            height,
            viewport: window.innerHeight,
            gap: GAP,
            edge: EDGE
          }).top
        }
    el.style.left = `${left}px`
    el.style.top = `${top}px`

    // The offset sizes are rounded; the rect is what the box will settle on, so the morph ends there
    // without a last-frame snap.
    const to = el.getBoundingClientRect()
    const m = tipMorph(from, to, window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    if (!m) return
    // Hold the text at its final measure while the box around it changes size, so it is never re-wrapped
    // mid-morph. The box clips it (`overflow: clip`) wherever the box is smaller.
    body.style.width = `${body.getBoundingClientRect().width}px`
    //
    // The text is not faded in: a sweep re-fills the label once per host, and a fade restarting from
    // nothing each time reads as the text flickering. It changes at once, and the box reveals it.
    const morph = el.animate(
      [
        { transform: `translate(${m.dx}px, ${m.dy}px)`, width: `${m.width}px`, height: `${m.height}px` },
        { transform: 'none', width: `${to.width}px`, height: `${to.height}px` }
      ],
      MORPH
    )
    morph.onfinish = () => {
      body.style.width = ''
    }
    morphRef.current = morph
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={elRef}
      className={`sb-tip${tip.wide ? ' sb-tip-wide' : ''}${tip.compact ? ' sb-tip-compact' : ''}`}
      // A first guess only, so the label never paints at the viewport origin; the layout effect above
      // overwrites both before paint.
      style={tip.scrub ? { left: tip.hostRight + GAP, top: tip.hostTop } : { left: tip.x, top: tip.hostBottom + GAP }}
      role="tooltip"
    >
      <div ref={bodyRef}>
        {tip.sub || tip.meta ? (
          <>
            <div className="sb-tip-title">{tip.text}</div>
            {tip.sub && <div className="sb-tip-sub">{tip.sub}</div>}
            {tip.meta && <div className="sb-tip-meta"><MetaText text={tip.meta} /></div>}
          </>
        ) : (
          tip.text
        )}
      </div>
    </div>
  )
}
