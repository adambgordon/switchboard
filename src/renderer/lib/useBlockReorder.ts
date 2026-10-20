import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import {
  blockEdgeSpeed,
  clampCenter,
  cloneTop,
  contentY,
  dragEdgeSpeed,
  dragStride,
  dropIndex,
  dropNeighbors,
  groupLanding,
  siblingsResized,
  slotShift,
  type Slot
} from './blockReorder'
import { dragScrollFeedback, dragScrollRequest, type EdgeMotion } from './edgeScroll'
import { COLLAPSE_ID, collapseUnits } from './groupCollapse'
import { FOLD_ID } from './folderFold'

/**
 * Click + drag to reorder the rail: rows within their block (a folder's pinned rows, its unpinned
 * rows, or All mode's two lists), and folders among folders by their header. One instance serves the
 * whole rail. It knows nothing about conversations — only this DOM contract:
 *
 * - a draggable UNIT carries `data-key`, and is a direct child of its BLOCK, which carries `data-block`;
 * - the gesture starts on a `data-drag` handle — the row itself, or a folder's header, whose unit is the
 *   folder around it — and never on anything inside `data-no-drag`;
 * - a drop reports the unit's key and the keys it landed between, which is all a rank write needs.
 *
 * The grabbed unit lifts into a CLONE that follows the pointer while its siblings slide to open a gap
 * at the drop slot; order changes only on drop. The clone is `position: fixed` on `<body>`, never the
 * real unit transformed in place: the rail body's overflow clip beats any z-index, so a transformed
 * unit dragged toward the head would be cut off beneath it, and a folder's sticky header would paint over
 * it. The real unit stays in flow, hidden, as the gap. The clone sits in a host carrying the rail's
 * own classes, so every rail-scoped rule — density, selection, row padding — styles it exactly as it
 * looked in place.
 *
 * A block can ask for the rail to be reshaped while one of its units is dragged (`reshape`): the
 * folders block folds the dragged folder to its header, so it moves as one short card. The reshaped
 * layout is applied before anything is measured, the grabbed unit is held under the pointer while the
 * rail shrinks around it, and on drop the dropped unit is held where it landed while the rail opens
 * again.
 *
 * Geometry is captured once at drag start in the scroll container's CONTENT coordinates (see
 * `blockReorder`), so the rail can scroll under the drag — by wheel, or by bringing the dragged unit to
 * an edge band, which scrolls it the way the tab strip scrolls — without anything going stale. A scroll
 * re-targets on its own, since a wheel moves the rows under a pointer that has not moved.
 *
 * A unit can carry others of its block with it (`carry`) — rail rows picked together. They lift as
 * one stacked clone with a count, and every carried unit but the grabbed one folds out of the layout
 * (`collapseUnits`, the drag's reshape), so the block closes up around the grabbed unit and the drag is
 * that unit's own: one gap the clone's size, gliding as a single unit's does. On drop they land together, in the order they had, between the two
 * keys the gap sat between.
 *
 * Escape cancels a drag, and the release that follows does nothing.
 *
 * Anything that reshapes the rail mid-drag cancels it rather than guessing where the slots went:
 * `cancelKey` changing (mode, density, search), the dragged unit's block changing membership or moving
 * (a re-index, a collapse), or the rail unmounting.
 */

/**
 * A temporary change to the rail's layout for the length of a drag. `apply` must leave the layout the
 * drag will run in, so the drag measures it; `play` may then animate toward it; `revert` stops any
 * animation and undoes everything.
 */
export interface DragReshape {
  apply(): void
  play(): void
  revert(): void
  /** Ease back in from the reshaped layout `revert` just undid, once the drop's render has measured.
   *  `revealIn` is how long until the dragged unit itself shows again, in ms: what grows inside it would
   *  otherwise grow unseen. `clone` is the copy of the unit still settling over it until then — a copy
   *  of the reshaped unit, so anything of the reshape it shows can be undone on it too — or null when
   *  the unit is already showing. */
  grow?(revealIn: number, clone: HTMLElement | null): void
}

export interface BlockDrop {
  block: string
  key: string
  /** The unit now directly above the drop, or null at the block's top. */
  above: string | null
  /** The unit now directly below, or null at the bottom. */
  below: string | null
  /** A group drop: every carried key, in block order, `key` among them. Absent for a single unit. */
  keys?: string[]
}

interface BlockReorderOpts {
  /** False while searching: the rail is filtered, so there is no order to change. */
  enabled: boolean
  onDrop: (drop: BlockDrop) => void
  /** Changes once a drop has committed: the clone then settles into the unit's new slot. */
  commitKey: unknown
  /** Any change cancels a drag in progress. */
  cancelKey: string
  /** How to reshape the rail while `unit` of this block is dragged, or null to leave it alone. */
  reshape?: (blockId: string, unit: HTMLElement) => DragReshape | null
  /** The keys a drag of `key` carries, `key` among them — read once, as the drag begins. `blockKeys`
   *  is the block's units in order. Absent, or one key, drags the unit alone. */
  carry?: (blockId: string, key: string, blockKeys: readonly string[]) => readonly string[]
}

const DRAG_THRESHOLD = 4
const SETTLE_MS = 200
const SPRING = 'cubic-bezier(0.22, 1, 0.36, 1)'
// How far the clone may travel past its block before it stops, so it never floats off with the
// pointer: half a row, which leaves the extreme slots easy to reach — targeting clamps separately, to
// the block's full extent. A folder can be taller than the rail, so it gets a fixed distance instead.
const ROW_OVERSHOOT_RATIO = 0.5
const FOLDER_OVERSHOOT = 24
// A folder's card reaches this far past the folder on either side, so its icon — which hangs into the
// rail's padding in place — sits inside the card rather than against its edge.
const FOLDER_CARD_INSET = 8

interface Drag {
  unit: HTMLElement
  block: HTMLElement
  blockId: string
  els: HTMLElement[]
  keys: string[]
  slots: Slot[]
  from: number
  target: number
  stride: number
  height: number
  overshoot: number
  /** The pointer's offset from the unit's top when it was grabbed. */
  grab: number
  /** The reshaping this drag applied, and the scroll it started from. */
  shape: DragReshape | null
  startScroll: number
  /** A group drag: the block's every key, the carried ones' indices in it (ascending, the grabbed
   *  one's among them), and the carried units other than the grabbed one, folded out of the layout
   *  for the drag (its `shape`). `els`, `keys` and `slots` above leave those out. Null for a single unit. */
  group: { keys: string[]; carried: number[]; others: HTMLElement[] } | null
}

interface Lifted {
  host: HTMLElement
  clone: HTMLElement
  /** A group's shell: the clone, its backing cards and its count, moved as one. Null for one unit. */
  shell: HTMLElement | null
}

const blockSelector = (id: string): string => `[data-block="${CSS.escape(id)}"]`
const unitsOf = (block: HTMLElement): HTMLElement[] =>
  Array.from(block.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.dataset.key !== undefined)

function findBlock(container: HTMLElement, id: string): HTMLElement | null {
  return container.dataset.block === id ? container : container.querySelector<HTMLElement>(blockSelector(id))
}

/** Lift `unit` into a fixed clone, in a host that carries the rail's classes. */
function lift(container: HTMLElement, unit: HTMLElement, rect: DOMRect, count = 1): Lifted {
  const rail = container.closest<HTMLElement>('.sb-rail')
  const host = document.createElement('div')
  host.className = `${rail?.className ?? ''} sb-drag-host`
  host.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;background:none;pointer-events:none;z-index:1000'
  const body = document.createElement('div')
  body.className = 'sb-rail-body'
  body.style.cssText = 'position:static;overflow:visible;padding:0;display:block'
  const clone = unit.cloneNode(true) as HTMLElement
  // A folder's header can rise into the space above it by a negative margin; on a card that would put
  // it outside the card's top edge. Fold the margin into padding, which keeps its text where it was.
  const head = unit.querySelector<HTMLElement>(':scope > .sb-group-head')
  const cloneHead = clone.querySelector<HTMLElement>(':scope > .sb-group-head')
  // The header has space above its name and none below, which on a card would seat the name on the
  // card's bottom edge. Pad the foot to match, growing the card rather than moving the name, which
  // must stay where it was under the pointer.
  let grow = 0
  if (head && cloneHead) {
    const cs = getComputedStyle(head)
    const above = parseFloat(cs.paddingTop) + parseFloat(cs.marginTop)
    const below = parseFloat(cs.paddingBottom)
    grow = Math.max(0, above - below)
    cloneHead.style.marginTop = '0'
    cloneHead.style.paddingTop = `${above}px`
    cloneHead.style.paddingBottom = `${below + grow}px`
  }
  clone.classList.add('dragging', 'sb-drag-clone')
  // A row keeps its own padding (the rail's density rules reach it through the host); only a folder's
  // card is widened, and padded back by the same amount so its content does not move.
  const inset = unit.classList.contains('sb-row') ? 0 : FOLDER_CARD_INSET
  const pad = inset ? `padding:0 ${inset}px;` : ''
  const fixed = `position:fixed;top:${rect.top}px;left:${rect.left - inset}px;width:${rect.width + 2 * inset}px;height:${rect.height + grow}px;`
  const box = `margin:0;${pad}box-sizing:border-box;overflow:hidden;pointer-events:none`
  if (count <= 1) {
    clone.style.cssText = fixed + box
    body.appendChild(clone)
    host.appendChild(body)
    document.body.appendChild(host)
    return { host, clone, shell: null }
  }
  // A group reads as a small stack with a count, as a tab group's drag does: one backing card for two,
  // two for more. Faked rather than N clones — only the top one is ever legible, and the count says
  // the rest. The tab strip's construction, for the same reason: the cards are pseudo-elements of ONE
  // shell, the clone's own size, so every corner shares one geometry and one rasterization, and only
  // the shell moves. Separately placed cards at fractional positions round each on their own, and
  // their corners never quite line up with the clone's.
  // It drops the selection's inverted look: one inverted card heading a stack of plain ones reads as
  // a different kind of thing rather than more of the same, and the rows land with their own looks.
  clone.classList.remove('selected', 'picked')
  clone.classList.add('stacked')
  clone.style.cssText = `position:absolute;inset:0;width:100%;height:100%;z-index:2;${box}`
  const shell = document.createElement('div')
  shell.className = `sb-row-drag-shell stacked${count > 2 ? ' stacked-many' : ''}`
  shell.style.cssText = `${fixed}pointer-events:none`
  shell.appendChild(clone)
  // Over the clone's top-right corner, on the shell, since the clone clips its own overflow.
  const badge = document.createElement('span')
  badge.className = 'sb-row-dragcount'
  badge.textContent = String(count)
  shell.appendChild(badge)
  body.appendChild(shell)
  host.appendChild(body)
  document.body.appendChild(host)
  return { host, clone, shell }
}

/** Place a lifted clone — a group's whole shell — at a viewport top. */
function placeLifted(lifted: Lifted, top: number): void {
  ;(lifted.shell ?? lifted.clone).style.top = `${top}px`
}

/**
 * Ease the clone into its settled slot while it drops the lifted look, as one motion. It animates to
 * the real unit's computed background and shadow, so the hand-back at the end is seamless. `.dragging`
 * is removed first because its `!important` outranks an animation keyframe — the lifted values are
 * captured before that, then animated from.
 */
/** How far below a unit's top its handle's content starts — a folder's name, a row's title. */
function contentOffset(unit: HTMLElement): number {
  const handle = unit.matches('[data-drag]') ? unit : unit.querySelector<HTMLElement>('[data-drag]') ?? unit
  return handle.getBoundingClientRect().top + parseFloat(getComputedStyle(handle).paddingTop) - unit.getBoundingClientRect().top
}

/** Returns how long until the real unit shows, in ms. */
function settle({ host, clone, shell }: Lifted, slotTop: number, real: HTMLElement | null): number {
  // The group has landed as rows of its own, so its stack and count go at once and the clone settles
  // alone, taken out of the shell where it stood. It takes its row's look back the moment it lands —
  // fill and ink together, as a selection snaps — since the rest of the group is already showing
  // theirs: only its place and its lift ease out.
  const regrouped = shell !== null
  if (shell) {
    const r = shell.getBoundingClientRect()
    clone.style.cssText = `position:fixed;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;margin:0;box-sizing:border-box;overflow:hidden;pointer-events:none`
    clone.classList.remove('stacked')
    for (const c of ['selected', 'picked']) clone.classList.toggle(c, !!real?.classList.contains(c))
    shell.replaceWith(clone)
  }
  const reveal = (): void => {
    host.remove()
    if (real) real.style.visibility = ''
  }
  // Landed, its content must sit where the real unit's does — not its box where the unit's box is. The
  // clone was built where the unit was picked up, and a unit can land where it is spaced differently:
  // the first folder's header rises into the rail's padding, which no other folder's does.
  const target = slotTop + (real ? contentOffset(real) - contentOffset(clone) : 0)
  const dy = clone.getBoundingClientRect().top - target
  if (Math.abs(dy) <= 0.5) {
    reveal()
    return 0
  }
  clone.style.top = `${target}px`
  const lifted = getComputedStyle(clone)
  const from = { backgroundColor: lifted.backgroundColor, boxShadow: lifted.boxShadow }
  const rest = real ? getComputedStyle(real) : null
  const to = { backgroundColor: rest ? rest.backgroundColor : 'transparent', boxShadow: rest ? rest.boxShadow : 'none' }
  if (regrouped) from.backgroundColor = to.backgroundColor
  clone.classList.remove('dragging')
  const anim = clone.animate(
    [
      { transform: `translateY(${dy}px)`, ...from },
      { transform: 'translateY(0)', ...to }
    ],
    { duration: SETTLE_MS, easing: SPRING, fill: 'forwards' }
  )
  // The real unit travels with its clone, from under it to its slot. Hidden, it shows nothing — except
  // what a reshape lets show while it settles, a dropped folder's rows, which then stay under their
  // header instead of waiting in the slot for it to slide onto them.
  real?.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: SETTLE_MS, easing: SPRING })
  anim.onfinish = reveal
  return SETTLE_MS
}

export function useBlockReorder(containerRef: RefObject<HTMLElement>, opts: BlockReorderOpts): void {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const dragRef = useRef<Drag | null>(null)
  const cancelRef = useRef<() => void>(() => {})
  // A committed drop's clone, waiting for the render that moves its unit.
  const pendingRef = useRef<{
    blockId: string
    key: string
    lifted: Lifted
    shape: DragReshape | null
    /** It carried a group, whose other units grow back in around the dropped one (see below). */
    group: boolean
  } | null>(null)

  // After a drop commits: the siblings are already at their final slots, so clearing their transforms
  // is seamless, and the clone eases into the unit's new one. Also the release's fallback, for a drop
  // that renders nothing: then everything is back where it started, and the clone eases home.
  const flushPending = useCallback(() => {
    const pending = pendingRef.current
    const container = containerRef.current
    if (!pending || !container) return
    pendingRef.current = null
    const block = findBlock(container, pending.blockId)
    const units = block ? unitsOf(block) : []
    // The drag's class goes before the siblings' transforms do: it is what lets them glide while the gap
    // moves, and still on, it would glide each one back by its shift — from where the drag held it, as
    // measured from its new place in the order.
    document.body.classList.remove('sb-dragging-row')
    for (const u of units) u.style.transform = ''
    const real = units.find((u) => u.dataset.key === pending.key) ?? null
    if (pending.shape) {
      // Open the rail again — a folder unfolded, a group's other units back. A folder is held where it
      // landed. A group is not: its other units grow back in from nothing, so the rail is unchanged at
      // the instant of the drop and the group opens out from where it was put; holding the dropped unit
      // would scroll everything above it by what is about to grow, then let it glide back.
      const landed = real?.getBoundingClientRect().top ?? 0
      pending.shape.revert()
      if (real && !pending.group) container.scrollTop += real.getBoundingClientRect().top - landed
    }
    const revealIn = settle(pending.lifted, real ? real.getBoundingClientRect().top : pending.lifted.clone.getBoundingClientRect().top, real)
    pending.shape?.grow?.(revealIn, revealIn > 0 ? pending.lifted.clone : null)
  }, [containerRef])
  const flushRef = useRef(flushPending)
  flushRef.current = flushPending
  useLayoutEffect(flushPending, [flushPending, opts.commitKey])

  // Every render during a drag: if the dragged block changed membership, a sibling changed size (a row
  // arriving in another folder), or the unit moved (a re-index above it, a collapse), its captured
  // slots no longer describe the screen — cancel. A reshaped rail skips the unit's own position: the
  // reshape may still be animating the unit toward the layout the drag measured, so it is expected to
  // move — and so is every sibling below it, which is why siblings are compared by size, not place.
  useLayoutEffect(() => {
    const drag = dragRef.current
    const container = containerRef.current
    if (!drag || !container) return
    // A group's other units are out of the layout, and out of what the drag measured.
    const units = (drag.block.isConnected ? unitsOf(drag.block) : []).filter((u) => !drag.group?.others.includes(u))
    const same = units.length === drag.els.length && units.every((u, i) => u === drag.els[i])
    const resized = same && siblingsResized(units.map((u) => u.getBoundingClientRect().height), drag.slots, drag.from)
    const r = container.getBoundingClientRect()
    const top = contentY(drag.unit.getBoundingClientRect().top, r.top, container.scrollTop)
    const moved = !drag.shape && Math.abs(top - drag.slots[drag.from].top) > 0.5
    if (!same || resized || moved) cancelRef.current()
  })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let pressed: { unit: HTMLElement; handle: HTMLElement; block: HTMLElement; pointerId: number; startY: number } | null = null
    let lifted: Lifted | null = null
    let latestY = 0
    let suppressClick = false
    // Escape canceled a drag while the button was still down: the release that ends the press must not
    // then click whatever it lands on.
    let escaped = false
    // Pointer moves are coalesced to one update per frame: a high-rate pointer reports several moves a
    // frame, and each update reads layout and writes styles. The release reads its own position exactly.
    let moveFrame: number | null = null
    let edgeFrame: number | null = null
    let edgeTime = 0
    let edgeMotion: EdgeMotion<HTMLElement> | null = null

    const applyShift = (drag: Drag, target: number): void => {
      if (target === drag.target) return
      drag.target = target
      drag.els.forEach((u, i) => {
        if (i === drag.from) return
        const shift = slotShift(i, drag.from, target, drag.stride)
        u.style.transform = shift ? `translateY(${shift}px)` : ''
      })
    }

    // Place the clone and re-target from the pointer and the current scroll. Called on every move, every
    // scroll, and every autoscroll frame.
    const update = (): void => {
      const drag = dragRef.current
      if (!drag) return
      const r = el.getBoundingClientRect()
      const scroll = el.scrollTop
      const top = contentY(latestY, r.top, scroll) - drag.grab
      const view = { top: scroll, bottom: scroll + el.clientHeight }
      if (lifted) placeLifted(lifted, cloneTop(top, drag.slots, drag.height, drag.overshoot, view) - scroll + r.top)
      applyShift(drag, dropIndex(clampCenter(top + drag.height / 2, drag.slots), drag.slots, drag.from))
    }

    const stopEdgeScroll = (): void => {
      if (edgeFrame != null) cancelAnimationFrame(edgeFrame)
      edgeFrame = null
      edgeMotion = null
    }

    const edgeSpeed = (drag: Drag): number => {
      const r = el.getBoundingClientRect()
      const top = latestY - drag.grab
      const speed = dragEdgeSpeed(top, top + drag.height, latestY, r.top, r.top + el.clientHeight)
      return blockEdgeSpeed(speed, drag.slots, el.scrollTop, el.clientHeight)
    }

    const scrollAtEdge = (time: number): void => {
      edgeFrame = null
      const drag = dragRef.current
      if (!drag) return stopEdgeScroll()
      const before = el.scrollTop
      const request = dragScrollRequest(edgeMotion, el, edgeSpeed(drag), time - edgeTime, before, el.scrollHeight - el.clientHeight)
      if (!request) return stopEdgeScroll()
      el.scrollTop += request.delta
      edgeMotion = dragScrollFeedback(request, before, el.scrollTop, 1 / window.devicePixelRatio)
      edgeTime = time
      if (el.scrollTop !== before) update()
      if (!edgeMotion) return stopEdgeScroll()
      edgeFrame = requestAnimationFrame(scrollAtEdge)
    }

    const startEdgeScroll = (): void => {
      if (edgeFrame != null) return
      edgeTime = performance.now()
      edgeMotion = null
      edgeFrame = requestAnimationFrame(scrollAtEdge)
    }

    const release = (pointerId: number): void => {
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId)
    }

    // `keepShift` holds the siblings where a committing drop left them: they are already at their final
    // slots, and the commit's layout effect clears their transforms once the new order has rendered.
    const reset = (keepShift = false): void => {
      if (moveFrame != null) cancelAnimationFrame(moveFrame)
      moveFrame = null
      stopEdgeScroll()
      const drag = dragRef.current
      dragRef.current = null
      if (pressed) release(pressed.pointerId)
      pressed = null
      if (drag && !keepShift) for (const u of drag.els) u.style.transform = ''
    }

    // Undo the drag's reshaping of the rail, back to the scroll it started from — except under a group,
    // whose units grow back in from where the rail stands now, for the reason a dropped group's do.
    const unshape = (drag: Drag): void => {
      if (!drag.shape) return
      drag.shape.revert()
      if (!drag.group) el.scrollTop = drag.startScroll
    }

    const cancel = (): void => {
      const drag = dragRef.current
      reset()
      if (drag) {
        drag.unit.style.visibility = ''
        unshape(drag)
        drag.shape?.grow?.(0, null)
      }
      lifted?.host.remove()
      lifted = null
      document.body.classList.remove('sb-dragging-row')
    }
    cancelRef.current = cancel

    const begin = (e: PointerEvent): boolean => {
      if (!pressed) return false
      const { unit, handle, block } = pressed
      // Anything still growing back in from the last drop is measured at its full size.
      for (const a of el.getAnimations({ subtree: true })) if (a.id === COLLAPSE_ID || a.id === FOLD_ID) a.finish()
      const all = unitsOf(block)
      const blockId = block.dataset.block
      if (all.length < 2 || !all.includes(unit) || !blockId) return false
      const allKeys = all.map((u) => u.dataset.key ?? '')
      const carriedKeys = optsRef.current.carry?.(blockId, allKeys[all.indexOf(unit)], allKeys) ?? []
      const carried = allKeys.flatMap((k, i) => (carriedKeys.includes(k) ? [i] : []))
      const others = carried.length > 1 && carried.includes(all.indexOf(unit)) ? carried.map((i) => all[i]).filter((u) => u !== unit) : []
      const els = all.filter((u) => !others.includes(u))
      // Nothing left to move among: every unit in the block is carried.
      if (els.length < 2) return false
      const from = els.indexOf(unit)
      // The HANDLE is what sits under the pointer: for a folder, its header, which may be stuck to the
      // rail's top while the folder's own top has scrolled far above it.
      const pressedAt = handle.getBoundingClientRect().top
      const startScroll = el.scrollTop
      // A group closes up: its other units fold away, and the block reflows around the grabbed one, so
      // what is measured below is a single unit's drag. Only rows are carried, and rows have no reshape
      // of their own.
      const shape = others.length > 0 ? collapseUnits(others) : optsRef.current.reshape?.(blockId, unit) ?? null
      shape?.apply()
      if (shape) {
        // Hold the handle under the pointer while the rail reshapes around it — as far as the scroll
        // range allows: a reshape that removes the overflow clamps the scroll, and the handle moves.
        el.scrollTop += handle.getBoundingClientRect().top - pressedAt
      }
      const r = el.getBoundingClientRect()
      const scroll = el.scrollTop
      const slots = els.map((u) => {
        const b = u.getBoundingClientRect()
        return { top: contentY(b.top, r.top, scroll), height: b.height }
      })
      const rect = unit.getBoundingClientRect()
      // The pointer keeps its grip on the handle wherever the handle ended up: its offset within the handle
      // at the press, plus the handle's place within the (reshaped) unit.
      const grab = pressed.startY - pressedAt + (handle.getBoundingClientRect().top - rect.top)
      const isRow = unit.classList.contains('sb-row')
      const keys = els.map((u) => u.dataset.key ?? '')
      const group = others.length > 0 ? { keys: allKeys, carried, others } : null
      dragRef.current = {
        unit,
        block,
        blockId,
        els,
        keys,
        slots,
        from,
        target: from,
        stride: dragStride(slots, from),
        height: rect.height,
        overshoot: isRow ? rect.height * ROW_OVERSHOOT_RATIO : FOLDER_OVERSHOOT,
        grab,
        shape,
        startScroll,
        group
      }
      el.setPointerCapture(e.pointerId)
      lifted = lift(el, unit, rect, group ? carried.length : 1)
      // Measured; now the reshape may animate toward the layout just measured.
      shape?.play()
      unit.style.visibility = 'hidden'
      document.body.classList.add('sb-dragging-row')
      return true
    }

    const onPointerDown = (e: PointerEvent): void => {
      escaped = false
      if (e.button !== 0 || !optsRef.current.enabled || dragRef.current) return
      // ⌘ and ⇧ pick rows; they must not also arm a drag, or picking out several rows would drag
      // whichever one the pointer wandered off first. The tab strip's rule (useTabReorder).
      if (e.metaKey || e.shiftKey) return
      const t = e.target instanceof Element ? e.target : null
      if (!t || t.closest('[data-no-drag]')) return
      const handle = t.closest<HTMLElement>('[data-drag]')
      const unit = handle?.closest<HTMLElement>('[data-key]') ?? null
      const block = unit?.parentElement
      if (!handle || !unit || !block || block.dataset.block === undefined || !el.contains(unit)) return
      pressed = { unit, handle, block, pointerId: e.pointerId, startY: e.clientY }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!pressed || e.pointerId !== pressed.pointerId) return
      // The press ended somewhere this rail never heard about — released outside it before a drag began.
      if (!dragRef.current && (e.buttons & 1) === 0) {
        pressed = null
        return
      }
      latestY = e.clientY
      if (!dragRef.current) {
        if (Math.abs(e.clientY - pressed.startY) < DRAG_THRESHOLD) return
        if (!begin(e)) {
          pressed = null
          return
        }
        // The first move places the clone at once; later ones wait for the frame.
        e.preventDefault()
        update()
        startEdgeScroll()
        return
      }
      e.preventDefault()
      if (moveFrame != null) return
      moveFrame = requestAnimationFrame(() => {
        moveFrame = null
        if (!dragRef.current) return
        update()
        startEdgeScroll()
      })
    }

    const swallowNextClick = (): void => {
      suppressClick = true
      window.setTimeout(() => {
        suppressClick = false
      }, 0)
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (escaped) {
        escaped = false
        swallowNextClick()
      }
      if (!pressed || e.pointerId !== pressed.pointerId) return
      const drag = dragRef.current
      if (!drag) {
        pressed = null
        return
      }
      latestY = e.clientY
      update()
      // A real drag ends in a click on the unit; swallow it so it does not also select or collapse.
      swallowNextClick()
      const { from, target, keys, blockId, group } = drag
      // A single unit's drop target is its index among the rest, which for a group is where the carried
      // units land among the units not carried.
      const landing = group ? groupLanding(group.keys, group.carried, target) : null
      const moves = landing ? landing.moved : target !== from
      const held = lifted
      lifted = null
      reset(moves)
      if (!held) return
      if (moves) {
        // The layout effect above settles the clone once this drop has re-rendered.
        const pending = { blockId, key: keys[from], lifted: held, shape: drag.shape, group: !!group }
        pendingRef.current = pending
        try {
          optsRef.current.onDrop(
            landing
              ? { block: blockId, key: keys[from], above: landing.above, below: landing.below, keys: group!.carried.map((i) => group!.keys[i]) }
              : { block: blockId, key: keys[from], ...dropNeighbors(keys, from, target) }
          )
        } finally {
          // A drop the app refused, or that threw, renders nothing, and nothing would ever settle the
          // clone or show its unit again. By the next frame a real drop has rendered and settled.
          requestAnimationFrame(() => {
            if (pendingRef.current === pending) flushRef.current()
          })
        }
      } else {
        unshape(drag)
        // Settled first, and unconditionally: an optional call skips its arguments along with itself.
        const revealIn = settle(held, drag.unit.getBoundingClientRect().top, drag.unit)
        drag.shape?.grow?.(revealIn, revealIn > 0 ? held.clone : null)
        document.body.classList.remove('sb-dragging-row')
      }
    }

    const onPointerCancel = (e: PointerEvent): void => {
      if (pressed && e.pointerId === pressed.pointerId) cancel()
    }

    // Capture moves to the container once a drag starts; losing it for any other reason ends the drag.
    const onLostCapture = (e: PointerEvent): void => {
      if (dragRef.current && pressed && e.pointerId === pressed.pointerId) cancel()
    }

    // Captured ahead of everything else, so the key that ends the drag does not also close a find bar or
    // a menu behind it.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !dragRef.current) return
      e.preventDefault()
      e.stopPropagation()
      cancel()
      escaped = true
    }

    // A wheel moves the rows beneath a pointer that has not moved, so the drop target moves with them.
    const onScroll = (): void => {
      if (dragRef.current) update()
    }

    const onClickCapture = (e: MouseEvent): void => {
      if (!suppressClick) return
      e.stopPropagation()
      e.preventDefault()
      suppressClick = false
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerCancel)
    el.addEventListener('lostpointercapture', onLostCapture)
    el.addEventListener('scroll', onScroll)
    el.addEventListener('click', onClickCapture, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerCancel)
      el.removeEventListener('lostpointercapture', onLostCapture)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('click', onClickCapture, true)
      cancel()
      cancelRef.current = () => {}
    }
  }, [containerRef, opts.cancelKey])
}
