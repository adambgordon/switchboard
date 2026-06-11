import { useEffect, type RefObject } from 'react'

/** How long the bar lingers after scrolling stops — long enough to reach over and grab it. */
const HIDE_DELAY = 1100

/**
 * Core of the Obsidian-style auto-hiding scrollbar: while `el` scrolls, add `is-scrolling` (CSS
 * reveals the thumb), then remove it a beat after scrolling stops. Returns a cleanup that detaches
 * the listener. Pair with the shared `.sb-autoscroll` CSS (thumb transparent at rest). Used by the
 * ref hook below (rail / New-menu / transcript) and directly by TerminalView for xterm's viewport,
 * so every scroll surface shares one mechanic.
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

/** Hook form for an element held in a ref (rail body, New-menu list). */
export function useAutoHideScrollbar(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return attachAutoHide(el)
  }, [ref])
}
