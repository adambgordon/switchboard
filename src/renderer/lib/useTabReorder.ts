import { useEffect, useRef, type RefObject } from 'react'
import { pointInRect, tabDropIndex } from './dropTarget'

/**
 * Drag a tab: to reorder its own strip, to the other pane, to another window, or off on its own.
 *
 * Pointer-based rather than HTML5 drag-and-drop, matching the rail's pinned-row reorder — but a
 * separate hook, not a generalisation of it. The rail is a single column of uniform rows with a fixed
 * stride, and it drags within ONE container; a tab strip wraps into rows, the tabs have different
 * widths, and a drag can legitimately end in a different container, a different window, or nowhere.
 * Folding both into one hook would make the rail's arithmetic conditional on cases it never has, and
 * the rail's arithmetic is the part that must not regress.
 *
 * The moving tab is a `position: fixed` CLONE on `document.body`, with the real tab left in place and
 * `visibility: hidden`. Two reasons, both the same as the rail's: the strip is a scroll container, so a
 * transformed child would be geometrically clipped at its edge rather than floating over the window;
 * and keeping the real tab in flow keeps its slot reserved, so the strip does not reflow under the
 * pointer mid-drag and every rect stays where the drop arithmetic expects it.
 *
 * WHERE the drop lands is `dropTarget`'s job, tested separately. This hook owns only the gesture: the
 * threshold, the clone, the caret, and which of the four outcomes to ask for.
 *
 * Cross-window is refereed by main (see `tabDragBegin`): while a button is held the OS delivers moves
 * only to the window the drag started in, so a window cannot detect a foreign tab over itself. This
 * hook therefore reports hover to main while the cursor is outside its own strips, and asks main at
 * release what became of the tab.
 */

/** How far the pointer must travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4

export interface TabReorderOpts {
  /** Which pane this strip belongs to. */
  paneIndex: number
  /** Session ids in this strip, in display order — resolves the pressed tab to an index. */
  order: string[]
  /** Off, so a drag cannot start. */
  enabled: boolean
  /** Reorder within this strip, or move to the other pane in this window. */
  onMove: (from: { pane: number; index: number }, to: { pane: number; index: number }) => void
  /** The tab went to another window, or off into a new one — drop it from this window. */
  onLeaveWindow: (sessionId: string) => void
}

export function useTabReorder(
  stripRef: RefObject<HTMLElement>,
  opts: TabReorderOpts
): void {
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const el = stripRef.current
    if (!el) return

    let pressed: HTMLElement | null = null
    let sessionId = ''
    let fromIndex = -1
    let startX = 0
    let startY = 0
    let dragging = false
    let clone: HTMLElement | null = null
    // Where inside the tab it was grabbed, so the clone stays under that same point rather than
    // snapping its corner to the cursor.
    let grabDx = 0
    let grabDy = 0
    let caret: HTMLElement | null = null
    let overStrip: HTMLElement | null = null
    let target: { pane: number; index: number } | null = null
    let hoverPending = false
    let suppressClick = false

    /** Every strip in this window, with the pane each belongs to. */
    const allStrips = (): Array<{ el: HTMLElement; pane: number }> =>
      Array.from(document.querySelectorAll<HTMLElement>('.sb-tabstrip')).map((s) => ({
        el: s,
        pane: Number(s.dataset.pane ?? 0)
      }))

    const dropCaret = (): void => {
      caret?.remove()
      caret = null
      overStrip?.classList.remove('sb-drop-target')
      overStrip = null
    }

    /** Draw the insertion caret in `strip` at `index`, in the strip's own scrolled coordinates. */
    const drawCaret = (strip: HTMLElement, rects: DOMRect[], index: number): void => {
      if (!caret || overStrip !== strip) {
        caret?.remove()
        caret = document.createElement('div')
        caret.className = 'sb-tab-caret'
        strip.appendChild(caret)
      }
      const box = strip.getBoundingClientRect()
      if (rects.length === 0) {
        caret.style.transform = 'translate(0px, 0px)'
        caret.style.height = '100%'
        return
      }
      // At the END of the strip the caret marks the trailing edge of the last tab; anywhere else, the
      // leading edge of the tab it would push along.
      const atEnd = index >= rects.length
      const r = atEnd ? rects[rects.length - 1] : rects[index]
      const x = (atEnd ? r.right : r.left) - box.left
      const y = r.top - box.top + strip.scrollTop
      caret.style.transform = `translate(${x}px, ${y}px)`
      caret.style.height = `${r.height}px`
    }

    const updateTarget = (x: number, y: number): void => {
      const hit = allStrips().find((s) => pointInRect(s.el.getBoundingClientRect(), x, y))
      if (!hit) {
        // Outside every strip in this window. Main is the only party that can tell whether the cursor
        // is over ANOTHER window, so hand the question over — coalesced to one ask per frame, and only
        // for as long as the drag is outside.
        target = null
        dropCaret()
        if (!hoverPending) {
          hoverPending = true
          requestAnimationFrame(() => {
            hoverPending = false
            if (dragging) window.api.tabDragHover()
          })
        }
        return
      }
      const tabs = Array.from(hit.el.querySelectorAll<HTMLElement>('.sb-tab'))
      const rects = tabs.map((t) => t.getBoundingClientRect())
      // The dragged tab keeps its slot, so it must not count toward its own destination — but only in
      // the strip it came from; in the other pane it is not present at all.
      const skip = hit.pane === optsRef.current.paneIndex ? fromIndex : -1
      const index = tabDropIndex(rects, x, y, skip)
      target = { pane: hit.pane, index }
      if (overStrip !== hit.el) {
        dropCaret()
        overStrip = hit.el
        hit.el.classList.add('sb-drop-target')
      }
      // No caret when the drop would change nothing — the tab landing back on its own index. Only
      // that one index: `skipIndex` means the result is already post-removal, so one past it is a real
      // move (see the note in onPointerUp).
      if (skip >= 0 && index === fromIndex) {
        caret?.remove()
        caret = null
        return
      }
      drawCaret(hit.el, rects, index)
    }

    const finish = (): void => {
      clone?.remove()
      clone = null
      dropCaret()
      if (pressed) pressed.style.visibility = ''
      document.body.classList.remove('sb-dragging-tab')
      pressed = null
      dragging = false
      target = null
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0 || !optsRef.current.enabled) return
      const t = e.target as HTMLElement | null
      // The close button owns its own click.
      if (t?.closest('.sb-tab-close')) return
      const tab = t?.closest<HTMLElement>('.sb-tab') ?? null
      if (!tab) return
      const tabs = Array.from(el.querySelectorAll<HTMLElement>('.sb-tab'))
      fromIndex = tabs.indexOf(tab)
      if (fromIndex < 0) return
      sessionId = optsRef.current.order[fromIndex] ?? ''
      if (!sessionId) return
      pressed = tab
      startX = e.clientX
      startY = e.clientY
      dragging = false
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!pressed) return
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) {
          return
        }
        dragging = true
        pressed.setPointerCapture?.(e.pointerId)
        const r = pressed.getBoundingClientRect()
        const c = pressed.cloneNode(true) as HTMLElement
        c.classList.add('sb-tab-dragging')
        c.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;pointer-events:none;z-index:1200`
        grabDx = r.left - e.clientX
        grabDy = r.top - e.clientY
        document.body.appendChild(c)
        clone = c
        pressed.style.visibility = 'hidden'
        document.body.classList.add('sb-dragging-tab')
        window.api.tabDragBegin(sessionId)
      }
      e.preventDefault()
      if (clone) {
        clone.style.left = `${e.clientX + grabDx}px`
        clone.style.top = `${e.clientY + grabDy}px`
      }
      updateTarget(e.clientX, e.clientY)
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!pressed) return
      if (!dragging) {
        pressed = null
        return
      }
      // A real drag ends in a click on the tab; swallow it so the tab is not also activated.
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 0)
      // The RELEASE position decides, not wherever the last move happened to be.
      updateTarget(e.clientX, e.clientY)
      const landed = target
      const id = sessionId
      const from = { pane: optsRef.current.paneIndex, index: fromIndex }
      finish()
      if (landed) {
        window.api.tabDragCancel()
        // `to.index` needs NO adjustment for the removal that precedes the insertion. `tabDropIndex`
        // was given the dragged tab as `skipIndex`, so it never counted it — its result is already an
        // index into the list without it, which is exactly what the reducer splices into (it removes
        // first, then inserts at `to.index`). Subtracting one here shifted every rightward drag by a
        // slot. For the same reason the only no-op is landing back on its own index: one past that is
        // a genuine move, and treating it as a no-op silently swallowed it.
        if (landed.pane !== from.pane || landed.index !== from.index) {
          optsRef.current.onMove(from, landed)
        }
        return
      }
      // Released outside this window's strips — main resolves it against the cursor.
      void window.api.tabDragDrop().then((outcome) => {
        if (outcome !== 'cancelled') optsRef.current.onLeaveWindow(id)
      })
    }

    const onPointerCancel = (): void => {
      if (dragging) window.api.tabDragCancel()
      finish()
    }

    const onClickCapture = (ev: MouseEvent): void => {
      if (!suppressClick) return
      ev.stopPropagation()
      ev.preventDefault()
      suppressClick = false
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
      if (dragging) window.api.tabDragCancel()
      finish()
    }
  }, [stripRef])
}
