import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Click + drag a PINNED conversation row vertically to reorder the Pinned section. The grabbed row
 * lifts into a card that follows the pointer; the OTHER pinned rows slide live to open a gap at the
 * drop slot (the gap follows your drag). The Pinned section's total height stays fixed — the dragged
 * row keeps its slot reserved in flow (hidden) and siblings shift by exactly its stride to relocate
 * the one gap.
 *
 * The moving card is a **`position: fixed` clone appended to `document.body`**, not the real row
 * transformed in place. Why: `.sb-rail-body` is `overflow-y: auto`, which geometrically CLIPS a
 * transformed row at the body's top edge — so a card dragged up toward the live-sessions head got cut
 * off "under" it (z-index can't beat an overflow clip). A fixed clone escapes the scroll container and
 * floats over the head. The real row is `visibility: hidden` for the duration (keeps its slot = the
 * source gap), so the reshuffle/target/clamp math is unchanged — only the visual is the clone.
 *
 * The drop slot is chosen by the clone's (clamped) CENTER vs the siblings' midpoints — not the raw
 * cursor — so the top/bottom slots are reachable the moment the card overlaps the first/last row.
 * Order changes only on drop; a layout effect then clears the siblings' transforms (seamless, they're
 * already at their final slots) and eases the clone into the real row's settled slot before swapping
 * it back in. The FLIP glide for this commit is suppressed via the reorder nonce in controlSig.
 */

const DRAG_THRESHOLD = 4
const GAP = 5 // the rail body's inter-row flex gap (rail.css)
const SETTLE_MS = 200
const SPRING = 'cubic-bezier(0.22, 1, 0.36, 1)'
// How far the floating clone may travel past the Pinned section before it clamps, as a fraction of a
// row's height. 0.5 ⇒ the card's CENTER can't leave the section, so at the extremes ~half the card
// pokes past the head/foot and then stops — instead of following the pointer infinitely up/down.
const DRAG_OVERSHOOT_RATIO = 0.5

interface RowReorderOpts {
  /** False while searching (the section is filtered then) — no reordering. */
  enabled: boolean
  /** Current section order (display order, top-first) — to resolve from/to indices + drive the settle. */
  order: string[]
  onReorder: (from: number, to: number) => void
  /** CSS selector for this section's draggable rows, e.g. `.sb-row.pinned[data-session]`. Lets one
   *  container host several independent instances (Pinned + Live) — each owns the rows it matches. */
  selector: string
}

const clampN = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

// Ease the floating clone into its settled slot and let it DROP OUT of the lifted `.dragging` look at
// the same time — the slide (translateY) and the de-elevation (white fill + ring/shadow → the resting
// row's chrome) run as one motion, so releasing a pinned row reads as a single settle, not a slide
// then a snap-to-flat. The clone lives on `<body>`, so the contextual resting look (card / flat /
// selected) can't reach it via CSS; we read the real row's computed chrome and animate to exactly
// that, so the clone→real-row hand-off at the end is seamless. `.dragging` is dropped first because
// its `!important` bg/shadow outrank a Web-Animations keyframe in the cascade (important author beats
// the animation origin) — we capture the lifted values before removing it, then animate from them.
function settleClone(clone: HTMLElement, slotTop: number, realRow: HTMLElement | null): void {
  const reveal = (): void => {
    clone.remove()
    if (realRow) realRow.style.visibility = ''
  }
  const dy = clone.getBoundingClientRect().top - slotTop
  if (Math.abs(dy) <= 0.5) {
    reveal()
    return
  }
  clone.style.top = `${slotTop}px`
  const lifted = getComputedStyle(clone)
  const from = { backgroundColor: lifted.backgroundColor, boxShadow: lifted.boxShadow }
  const restEl = realRow ? getComputedStyle(realRow) : null
  const to = {
    backgroundColor: restEl ? restEl.backgroundColor : 'transparent',
    boxShadow: restEl ? restEl.boxShadow : 'none'
  }
  clone.classList.remove('dragging')
  const anim = clone.animate(
    [
      { transform: `translateY(${dy}px)`, ...from },
      { transform: 'translateY(0)', ...to }
    ],
    { duration: SETTLE_MS, easing: SPRING, fill: 'forwards' }
  )
  anim.onfinish = reveal
}

export function useRowReorder(containerRef: RefObject<HTMLElement>, opts: RowReorderOpts): void {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const pendingDrop = useRef<{ id: string } | null>(null)
  const cloneRef = useRef<HTMLElement | null>(null)

  // After a committed reorder re-renders, clear the siblings' transforms (they're already at their
  // final slots → seamless, pre-paint) and ease the clone into the dragged row's settled slot.
  useLayoutEffect(() => {
    const drop = pendingDrop.current
    if (!drop) return
    pendingDrop.current = null
    const clone = cloneRef.current
    cloneRef.current = null
    const el = containerRef.current
    if (!el) return
    for (const r of el.querySelectorAll<HTMLElement>('.sb-row')) {
      if (r.dataset.session !== drop.id) r.style.transform = ''
    }
    const realRow = el.querySelector<HTMLElement>(`.sb-row[data-session="${drop.id}"]`)
    if (clone) settleClone(clone, realRow ? realRow.getBoundingClientRect().top : clone.getBoundingClientRect().top, realRow)
    document.body.classList.remove('sb-dragging-row')
  }, [containerRef, opts.order])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let startY = 0
    let startCenter = 0
    let cloneStartTop = 0
    let cloneH = 0
    let dragging = false
    let dragged: HTMLElement | null = null
    let draggedIndex = -1
    let stride = 0
    let suppressClick = false
    // Natural (pre-transform) geometry of the pinned rows, captured once at drag start.
    let natural: Array<{ el: HTMLElement; top: number; height: number; index: number }> = []

    // Insertion index = how many non-dragged rows have their natural midpoint above the clone's center.
    const targetFor = (center: number): number => {
      let idx = 0
      for (const n of natural) {
        if (n.el === dragged) continue
        if (center > n.top + n.height / 2) idx++
      }
      return idx
    }

    const applyShift = (target: number): void => {
      for (const n of natural) {
        if (n.el === dragged) continue
        let shift = 0
        if (n.index > draggedIndex && n.index <= target) shift = -stride
        else if (n.index < draggedIndex && n.index >= target) shift = stride
        n.el.style.transform = shift ? `translateY(${shift}px)` : ''
      }
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !optsRef.current.enabled) return
      const t = e.target as HTMLElement | null
      if (t?.closest('.sb-row-menu-btn')) return // the ⋮ menu button owns its own click
      const hit = t?.closest<HTMLElement>(optsRef.current.selector) ?? null
      if (!hit) return
      dragged = hit
      draggedIndex = optsRef.current.order.indexOf(hit.dataset.session ?? '')
      startY = e.clientY
      dragging = false
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!dragged) return
      const dy = e.clientY - startY
      if (!dragging) {
        if (Math.abs(dy) < DRAG_THRESHOLD) return
        dragging = true
        dragged.setPointerCapture?.(e.pointerId)
        const rows = Array.from(el.querySelectorAll<HTMLElement>(optsRef.current.selector))
        natural = rows.map((r, i) => {
          const b = r.getBoundingClientRect()
          return { el: r, top: b.top, height: b.height, index: i }
        })
        stride = dragged.offsetHeight + GAP
        const r = dragged.getBoundingClientRect()
        startCenter = r.top + r.height / 2
        cloneStartTop = r.top
        cloneH = r.height
        // A fixed clone on <body> escapes the rail body's overflow clip → floats over the head.
        const clone = dragged.cloneNode(true) as HTMLElement
        clone.classList.add('dragging')
        clone.style.cssText = `position:fixed;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;margin:0;padding:10px;box-sizing:border-box;pointer-events:none;z-index:1000`
        document.body.appendChild(clone)
        cloneRef.current = clone
        dragged.style.visibility = 'hidden' // keep the slot (the source gap); the clone is the visual
        document.body.classList.add('sb-dragging-row')
      }
      e.preventDefault()
      const last = natural[natural.length - 1]
      // Clamp the clone's VISUAL travel to a partial overshoot past the Pinned section (≈ half a row),
      // so the card never floats off into the head/Live area — it used to follow the pointer infinitely.
      const clone = cloneRef.current
      if (clone) {
        const overshoot = cloneH * DRAG_OVERSHOOT_RATIO
        const minTop = natural[0].top - overshoot
        const maxTop = last.top + last.height - cloneH + overshoot
        clone.style.top = `${clampN(cloneStartTop + dy, minTop, maxTop)}px`
      }
      // The targeting center is clamped across the FULL section (independent of the visual clamp above)
      // so every slot — including the extremes — stays reachable.
      const center = clampN(startCenter + dy, natural[0].top, last.top + last.height)
      applyShift(targetFor(center))
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!dragged) return
      if (dragging) {
        const last = natural[natural.length - 1]
        const center = clampN(startCenter + (e.clientY - startY), natural[0].top, last.top + last.height)
        const target = targetFor(center)
        suppressClick = true
        window.setTimeout(() => {
          suppressClick = false
        }, 0)
        if (target !== draggedIndex) {
          // Defer to the layout effect (after the reorder re-render): it clears siblings + eases the
          // clone into the row's new slot. Keep the clone + body class alive until then.
          pendingDrop.current = { id: dragged.dataset.session ?? '' }
          optsRef.current.onReorder(draggedIndex, target)
        } else {
          // No change — ease the clone back to the row's (unchanged) slot now.
          for (const n of natural) if (n.el !== dragged) n.el.style.transform = ''
          const clone = cloneRef.current
          cloneRef.current = null
          if (clone) settleClone(clone, dragged.getBoundingClientRect().top, dragged)
          document.body.classList.remove('sb-dragging-row')
        }
      }
      dragged = null
      dragging = false
    }

    const onPointerCancel = (): void => {
      if (dragging) {
        for (const n of natural) if (n.el !== dragged) n.el.style.transform = ''
        cloneRef.current?.remove()
        cloneRef.current = null
        if (dragged) dragged.style.visibility = ''
        document.body.classList.remove('sb-dragging-row')
      }
      dragged = null
      dragging = false
    }

    // A real drag ends in a click on the row; swallow it so the row doesn't also open/select.
    const onClickCapture = (e: MouseEvent): void => {
      if (suppressClick) {
        e.stopPropagation()
        e.preventDefault()
        suppressClick = false
      }
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    el.addEventListener('click', onClickCapture, true)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('click', onClickCapture, true)
    }
  }, [containerRef])
}
