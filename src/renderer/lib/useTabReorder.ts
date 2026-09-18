import { useEffect, useRef, type RefObject } from 'react'
import { makeTabDragPayload } from '@shared/tabDrag'
import type { TabLayout } from './tabLayoutPreference'
import { tabEdgeScrollSpeed, tabDragScrollRequest, tabDragScrollFeedback, type TabEdgeMotion } from './tabScroll'
import {
  groupDragFollowerIndices,
  groupDragIndices,
  isGroupOriginDrop,
  pointInRect,
  tabCaretIndex,
  tabCaretPosition,
  tabDropIndex
} from './dropTarget'

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
  layout: TabLayout
  /** Which pane this strip belongs to. */
  paneIndex: number
  /** Session ids in this strip, in display order — resolves the pressed tab to an index. */
  order: string[]
  /** Off, so a drag cannot start. */
  enabled: boolean
  /** Reorder within this strip, or move to the other pane in this window. */
  onMove: (from: { pane: number; index: number }, to: { pane: number; index: number }) => void
  /**
   * The conversations that should travel with the dragged tab — the multi-selection when it belongs to
   * one, otherwise just itself. Resolved at drag START and used for the whole gesture, so a selection
   * changing mid-drag cannot alter what is being carried.
   */
  targetsFor: (sessionId: string) => string[]
  /** Move a whole group at once. Separate from `onMove` because a group cannot be expressed as a
   *  from-index: the tabs are scattered, and their indices shift as each one lands. */
  onMoveGroup: (
    sessionIds: string[],
    activeSessionId: string,
    to: { pane: number; index: number }
  ) => void
  /** The tab group went to another window, or off into a new one — drop it from this window. */
  onLeaveWindow: (sessionIds: string[]) => void
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
    let pointerId: number | null = null
    let sessionId = ''
    let fromIndex = -1
    /** What this drag carries. Fixed when the drag begins — see TabReorderOpts.targetsFor. */
    let carrying: string[] = []
    /** Every tab hidden for the duration, so a whole group vacates rather than just the one grabbed. */
    let vacated: HTMLElement[] = []
    let sourcePlaceholder: HTMLElement | null = null
    let sourceSkippedIndices: number[] = []
    let vacancyFollowers: HTMLElement[] = []
    let startX = 0
    let startY = 0
    let dragging = false
    let clone: HTMLElement | null = null
    let caret: HTMLElement | null = null
    let overStrip: HTMLElement | null = null
    let target: { pane: number; index: number } | null = null
    let moveFrame: number | null = null
    let edgeFrame: number | null = null
    let edgeTime = 0
    let edgeMotion: TabEdgeMotion<HTMLElement> | null = null
    let latestX = 0
    let latestY = 0
    let suppressClick = false
    /**
     * Escape releases the drag with nothing moved.
     *
     * Bound to the DOCUMENT for the duration rather than to the strip: the pointer is captured, so the
     * strip may not be under it, and a keystroke goes to whatever holds focus regardless. Capture phase
     * with `stopPropagation`, so the app's global Escape — which closes modals and the find bar — does
     * not also fire when getting out of a drag is what the user asked for.
     *
     * `finish()` nulls `pressed`, and every pointer handler returns early on that, so the release that
     * follows performs nothing on its own — no separate "aborted" flag is needed, and one would be a
     * guard with no observable effect.
     */
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !dragging) return
      e.preventDefault()
      e.stopPropagation()
      // The click that follows the release must not activate the tab either.
      suppressClick = true
      window.api.tabDragCancel()
      finish()
    }

    /** Every strip in this window, with the pane each belongs to. */
    const allStrips = (): Array<{ el: HTMLElement; pane: number }> =>
      Array.from(document.querySelectorAll<HTMLElement>('.sb-tabstrip')).map((s) => ({
        el: s,
        pane: Number(s.dataset.pane ?? 0)
      }))

    const stripTabs = (strip: HTMLElement): HTMLElement[] =>
      Array.from(strip.querySelectorAll<HTMLElement>('.sb-tab'))

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
      const { x, y } = tabCaretPosition(r, box, atEnd, strip.scrollLeft, strip.scrollTop)
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
        window.api.tabDragHover()
        return
      }
      const tabs = stripTabs(hit.el)
      const rects = tabs.map((t) => t.getBoundingClientRect())
      // Every carried tab remains in flow so surrounding tabs never move. Excluding all of their
      // indices only from the count still produces the fully-stripped destination moveMany expects.
      const skip = hit.pane === optsRef.current.paneIndex ? sourceSkippedIndices : []
      const index = tabDropIndex(rects, x, y, skip)
      target = { pane: hit.pane, index }
      if (overStrip !== hit.el) {
        dropCaret()
        overStrip = hit.el
        hit.el.classList.add('sb-drop-target')
      }
      // Always paint the destination, including the starting slot. The release path still treats
      // that index as a no-op; the caret is feedback about WHERE, not whether the move changes state.
      drawCaret(
        hit.el,
        rects,
        tabCaretIndex(index, rects.length, skip, sourceSkippedIndices[0])
      )
    }

    const showOriginTarget = (): void => {
      if (!sourcePlaceholder) return
      const tabs = stripTabs(el)
      const origin = sourceSkippedIndices[0]
      if (origin == null) return
      const rects = tabs.map((tab) => tab.getBoundingClientRect())
      target = { pane: optsRef.current.paneIndex, index: origin }
      dropCaret()
      overStrip = el
      el.classList.add('sb-drop-target')
      drawCaret(el, rects, tabCaretIndex(origin, rects.length, sourceSkippedIndices, origin))
    }

    const stopEdgeScroll = (): void => {
      if (edgeFrame != null) cancelAnimationFrame(edgeFrame)
      edgeFrame = null
      edgeMotion = null
    }

    const scrollAtEdge = (time: number): void => {
      edgeFrame = null
      const strip = overStrip
      if (!dragging || !strip || strip.dataset.layout !== 'scroll') {
        stopEdgeScroll()
        return
      }
      const box = strip.getBoundingClientRect()
      if (!pointInRect(box, latestX, latestY)) {
        stopEdgeScroll()
        return
      }
      const before = strip.scrollLeft
      const request = tabDragScrollRequest(
        edgeMotion, strip, tabEdgeScrollSpeed(latestX, box.left, box.right), time - edgeTime,
        before, strip.scrollWidth - strip.clientWidth
      )
      if (!request) {
        stopEdgeScroll()
        return
      }
      strip.scrollLeft += request.delta
      edgeMotion = tabDragScrollFeedback(request, before, strip.scrollLeft, 1 / window.devicePixelRatio)
      edgeTime = time
      if (strip.scrollLeft !== before) updateTarget(latestX, latestY)
      if (!edgeMotion) {
        stopEdgeScroll()
        return
      }
      edgeFrame = requestAnimationFrame(scrollAtEdge)
    }

    const startEdgeScroll = (): void => {
      if (edgeFrame != null) return
      edgeTime = performance.now()
      edgeMotion = null
      edgeFrame = requestAnimationFrame(scrollAtEdge)
    }

    const finish = (): void => {
      if (moveFrame != null) cancelAnimationFrame(moveFrame)
      moveFrame = null
      stopEdgeScroll()
      clone?.remove()
      clone = null
      dropCaret()
      // Restore every tab that vacated, not only the grabbed one — a group left hidden would look
      // like the drag deleted it.
      for (const n of vacated) {
        n.style.visibility = ''
      }
      vacated = []
      sourcePlaceholder = null
      sourceSkippedIndices = []
      for (const follower of vacancyFollowers) follower.classList.remove('sb-tab-after-drag-gap')
      vacancyFollowers = []
      if (pressed) pressed.style.visibility = ''
      document.body.classList.remove('sb-dragging-tab')
      document.removeEventListener('keydown', onKey, true)
      const pressedTab = pressed
      const capturedId = pointerId
      pressed = null
      pointerId = null
      dragging = false
      target = null
      if (capturedId != null) {
        if (el.hasPointerCapture(capturedId)) el.releasePointerCapture(capturedId)
        else if (pressedTab?.hasPointerCapture(capturedId)) pressedTab.releasePointerCapture(capturedId)
      }
    }

    const onPointerDown = (e: PointerEvent): void => {
      // A new press cannot be the click finishing an escaped drag released outside this strip.
      suppressClick = false
      if (pointerId != null || e.button !== 0 || !optsRef.current.enabled) return
      // ⌘ and ⇧ build a multi-selection; they must not also arm a drag, or picking out several tabs
      // would drag whichever one the pointer wandered off first.
      if (e.metaKey || e.shiftKey) return
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
      pointerId = e.pointerId
      // Capture on the tab until the threshold, so plain clicks still activate it. Capturing only
      // after an in-strip move misses a fast exit and leaves the press armed after an outside release.
      tab.setPointerCapture(e.pointerId)
      startX = e.clientX
      startY = e.clientY
      dragging = false
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!pressed || e.pointerId !== pointerId) return
      if (!(e.buttons & 1)) {
        onPointerCancel()
        return
      }
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) {
          return
        }
        dragging = true
        const payload = makeTabDragPayload(
          optsRef.current.order,
          optsRef.current.targetsFor(sessionId),
          sessionId
        )
        carrying = payload.sessionIds
        el.setPointerCapture(e.pointerId)
        const r = pressed.getBoundingClientRect()
        const shell = document.createElement('div')
        shell.className = 'sb-tab-drag-shell'
        shell.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;pointer-events:none;z-index:1200`
        const c = pressed.cloneNode(true) as HTMLElement
        c.classList.add('sb-tab-dragging')
        c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;margin:0;pointer-events:none;z-index:2'
        // A group reads as a small stack with a count, the way a multi-file drag does everywhere else.
        // Two tabs get one backing card; three or more get two. The badge carries the exact count, so
        // another visual layer would add cost without adding information.
        if (carrying.length > 1) {
          shell.classList.add('stacked')
          if (carrying.length > 2) shell.classList.add('stacked-many')
          const badge = document.createElement('span')
          badge.className = 'sb-tab-dragcount'
          badge.textContent = String(carrying.length)
          c.appendChild(badge)
        }
        shell.appendChild(c)
        document.body.appendChild(shell)
        clone = shell
        // Every carried tab stays in flow but becomes invisible, so the rest of the strip does not
        // move when the drag begins. The leftmost carried tab owns the default/origin caret.
        const els = Array.from(el.querySelectorAll<HTMLElement>('.sb-tab'))
        sourceSkippedIndices = groupDragIndices(optsRef.current.order, carrying)
        const placeholder = els[sourceSkippedIndices[0]] ?? pressed
        sourcePlaceholder = placeholder
        vacated = sourceSkippedIndices
          .map((index) => els[index])
          .filter((node): node is HTMLElement => !!node)
        if (!vacated.includes(pressed)) vacated.push(pressed)
        for (const n of vacated) n.style.visibility = 'hidden'
        const rowTops = els.map((tab) => tab.getBoundingClientRect().top)
        vacancyFollowers = groupDragFollowerIndices(sourceSkippedIndices, rowTops)
          .map((index) => els[index])
          .filter((node): node is HTMLElement => !!node)
        for (const follower of vacancyFollowers) follower.classList.add('sb-tab-after-drag-gap')
        showOriginTarget()
        document.body.classList.add('sb-dragging-tab')
        document.addEventListener('keydown', onKey, true)
        window.api.tabDragBegin(payload)
      }
      e.preventDefault()
      latestX = e.clientX
      latestY = e.clientY
      if (moveFrame == null) {
        moveFrame = requestAnimationFrame(() => {
          moveFrame = null
          if (!dragging) return
          if (clone) {
            clone.style.transform = `translate3d(${latestX - startX}px, ${latestY - startY}px, 0)`
          }
          updateTarget(latestX, latestY)
          startEdgeScroll()
        })
      }
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!pressed || e.pointerId !== pointerId) return
      if (!dragging) {
        finish()
        return
      }
      // A real drag ends in a click on the tab; swallow it so the tab is not also activated.
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 0)
      // The RELEASE position decides, not wherever the last move happened to be.
      if (moveFrame != null) cancelAnimationFrame(moveFrame)
      moveFrame = null
      if (clone) {
        clone.style.transform = `translate3d(${e.clientX - startX}px, ${e.clientY - startY}px, 0)`
      }
      updateTarget(e.clientX, e.clientY)
      const landed = target
      const group = carrying
      const from = { pane: optsRef.current.paneIndex, index: fromIndex }
      const groupOrigin = sourceSkippedIndices[0] ?? fromIndex
      finish()
      if (landed) {
        window.api.tabDragCancel()
        if (group.length > 1) {
          if (isGroupOriginDrop(from.pane, groupOrigin, landed)) return
          // Every carried source index was excluded from the count, so this destination addresses the
          // same fully-stripped list moveMany inserts into.
          optsRef.current.onMoveGroup(group, sessionId, landed)
          return
        }
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
        if (outcome === 'cancelled') return
        optsRef.current.onLeaveWindow(group)
      })
    }

    const onPointerCancel = (e?: PointerEvent): void => {
      if (e && e.pointerId !== pointerId) return
      if (dragging) window.api.tabDragCancel()
      finish()
    }

    const onLostCapture = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      // Moving capture from the tab to the strip emits loss on the tab too; that is not cancellation.
      if (el.hasPointerCapture(e.pointerId) || pressed?.hasPointerCapture(e.pointerId)) return
      onPointerCancel()
    }

    // Wheel scrolling during pointer capture also moves the target geometry beneath a still pointer.
    const onScroll = (event: Event): void => {
      if (dragging && event.target instanceof HTMLElement && event.target.matches('.sb-tabstrip')) {
        updateTarget(latestX, latestY)
        startEdgeScroll()
      }
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
    el.addEventListener('lostpointercapture', onLostCapture)
    el.addEventListener('click', onClickCapture, true)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('lostpointercapture', onLostCapture)
      el.removeEventListener('click', onClickCapture, true)
      document.removeEventListener('scroll', onScroll, true)
      if (dragging) window.api.tabDragCancel()
      finish()
    }
  }, [stripRef, opts.layout])
}
