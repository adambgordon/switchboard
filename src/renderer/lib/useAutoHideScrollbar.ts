import { useEffect, type RefObject } from 'react'

/** How long the bar lingers after scrolling stops — long enough to reach over and grab it. */
const HIDE_DELAY = 1100

/**
 * Core of the Obsidian-style auto-hiding scrollbar: while `el` scrolls, add `is-scrolling` (CSS
 * reveals the thumb), then remove it a beat after scrolling stops. Returns a cleanup that detaches
 * the listener. Pair with the shared `.sb-autoscroll` CSS (thumb transparent at rest).
 *
 * Reached through the ref hook below, for a surface held in a ref: the rail body and the
 * New-conversation menu. The transcript uses `attachAutoHideWithin` instead — same mechanic,
 * delegated, because its inner scrollers are too many and too anonymous to attach one by one.
 */
export function attachAutoHide(el: HTMLElement): () => void {
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  const onScroll = (): void => {
    el.classList.add('is-scrolling')
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => el.classList.remove('is-scrolling'), HIDE_DELAY)
  }
  el.addEventListener('scroll', onScroll, { passive: true })
  return () => {
    el.removeEventListener('scroll', onScroll)
    if (hideTimer) clearTimeout(hideTimer)
  }
}

/**
 * Delegated form: ONE listener covering `root` and every opted-in scroller inside it.
 *
 * `scroll` does not bubble, but a CAPTURE-phase listener on an ancestor still sees it — the event
 * travels the capture path down to its target regardless of `bubbles`. That is what makes a single
 * listener viable here.
 *
 * The transcript needs this shape rather than per-element attachment because its scrollers are
 * unbounded and anonymous: every fenced block, table, formula, and tool payload is one, they mount
 * and unmount as the view windows, and most hold no ref of their own. Attaching individually would
 * mean a listener per block plus a ref threaded into components that need one for nothing else.
 *
 * Opt-in is the `sb-autoscroll` class — the same class that carries the CSS — so the marker and the
 * styling can never disagree, and a scroller that has not opted in (xterm's viewport, which owns its
 * own attachment) is left alone.
 */
export function attachAutoHideWithin(root: HTMLElement): () => void {
  // Per-element timers: two blocks scrolled in turn must not cancel each other's reveal. Entries are
  // deleted as they fire, so this holds only what is inside the HIDE_DELAY window.
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()
  const onScroll = (e: Event): void => {
    const el = e.target
    if (!(el instanceof HTMLElement) || !el.classList.contains('sb-autoscroll')) return
    el.classList.add('is-scrolling')
    const pending = timers.get(el)
    if (pending) clearTimeout(pending)
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el)
        el.classList.remove('is-scrolling')
      }, HIDE_DELAY)
    )
  }
  root.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => {
    root.removeEventListener('scroll', onScroll, { capture: true })
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
  }
}

/** Hook form for an element held in a ref (rail body, New-menu list). */
export function useAutoHideScrollbar(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return attachAutoHide(el)
  }, [ref])
}
