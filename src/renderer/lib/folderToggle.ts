import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { afterMeasure } from './groupCollapse'
import { FOLD_ID } from './folderFold'

/** Mirror the motion tokens (--dur / --ease in tokens.css), as the drag's fold does. */
const TOGGLE_MS = 180
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
/** Clips only the folder's bottom edge, so a header rising above its box stays whole. */
const CLIP_BOTTOM = 'inset(-9999px -9999px 0 -9999px)'
/** Attributes a captured copy must not carry: what the rail, its drag and its glide find rows by, and
 *  what the tooltip layer reads. */
const STRIP = ['data-key', 'data-session', 'data-block', 'data-drag', 'data-no-drag', 'data-tip', 'id', 'tabindex']

interface Captured {
  /** The folder's height before the toggle — mid-animation, if one was running. */
  from: number
  /** A collapsing folder's rows as they were, to fold away; null for one opening. */
  ghost: HTMLElement | null
}

/** Each folder's current toggle animation, so a stale one's cleanup cannot undo a newer one's setup. */
const current = new WeakMap<HTMLElement, Animation>()

/**
 * Folding a folder open or closed in place eases its height between the two, as dragging one folds it
 * (`foldFolder`), instead of jumping.
 *
 * Call the returned `capture` with the folders about to toggle, just BEFORE the state change. It reads
 * each one's height then; once the toggle has rendered, the folder animates from that height to its new
 * one, clipped at its bottom edge, so opening uncovers its rows top to bottom and closing covers them.
 * A closing folder's rows are gone from the render by then, so `capture` also takes a copy of them as
 * they were — inert, and stripped of everything the rail finds rows by — to fold away in their place.
 *
 * Started after the render has measured (`afterMeasure`), so the rail's glide records where everything
 * ends up rather than where the fold starts. Toggles made any other way — revealing a row inside a
 * closed folder, say — stay instant.
 */
export function useFolderToggleMotion(containerRef: RefObject<HTMLElement>): (roots: readonly string[]) => void {
  const captured = useRef(new Map<string, Captured>())

  useLayoutEffect(() => {
    const pending = captured.current
    if (pending.size === 0) return
    captured.current = new Map()
    const container = containerRef.current
    if (!container) return
    const plays: (() => void)[] = []
    for (const [root, { from, ghost }] of pending) {
      const folder = findFolder(container, root)
      if (!folder) continue
      const to = folder.getBoundingClientRect().height
      if (Math.abs(to - from) <= 0.5) continue
      plays.push(() => play(folder, from, to, ghost))
    }
    if (plays.length > 0) afterMeasure(() => plays.forEach((p) => p()))
  })

  return useCallback(
    (roots: readonly string[]) => {
      const container = containerRef.current
      if (!container || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      for (const root of roots) {
        const folder = findFolder(container, root)
        if (!folder) continue
        const head = folder.querySelector<HTMLElement>(':scope > .sb-group-head')
        const body = Array.from(folder.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement && c !== head && !c.classList.contains('sb-folder-ghost')
        )
        captured.current.set(root, {
          from: folder.getBoundingClientRect().height,
          ghost: body.length > 0 ? copyRows(folder, body) : null
        })
      }
    },
    [containerRef]
  )
}

function findFolder(container: HTMLElement, root: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`:scope > .sb-group[data-key="${CSS.escape(root)}"]`)
}

/** The folder's rows as drawn now, laid out where they stand, ready to be dropped back into it. */
function copyRows(folder: HTMLElement, body: HTMLElement[]): HTMLElement {
  const box = folder.getBoundingClientRect()
  const first = body[0].getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'sb-folder-ghost'
  ghost.inert = true
  ghost.setAttribute('aria-hidden', 'true')
  ghost.style.cssText =
    `position:absolute;top:${first.top - box.top}px;left:${first.left - box.left}px;width:${first.width}px;` +
    `display:flex;flex-direction:column;gap:${getComputedStyle(folder).rowGap};pointer-events:none`
  for (const el of body) {
    const copy = el.cloneNode(true) as HTMLElement
    for (const node of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('*'))]) {
      for (const a of STRIP) node.removeAttribute(a)
    }
    ghost.appendChild(copy)
  }
  return ghost
}

function play(folder: HTMLElement, from: number, to: number, ghost: HTMLElement | null): void {
  for (const a of folder.getAnimations()) if (a.id === FOLD_ID) a.cancel()
  if (ghost) {
    folder.style.position = 'relative'
    folder.appendChild(ghost)
  }
  const anim = folder.animate(
    [
      { height: `${from}px`, clipPath: CLIP_BOTTOM },
      { height: `${to}px`, clipPath: CLIP_BOTTOM }
    ],
    { duration: TOGGLE_MS, easing: EASE, id: FOLD_ID }
  )
  current.set(folder, anim)
  const done = (): void => {
    ghost?.remove()
    if (current.get(folder) !== anim) return
    current.delete(folder)
    folder.style.removeProperty('position')
  }
  anim.onfinish = done
  anim.oncancel = done
}
