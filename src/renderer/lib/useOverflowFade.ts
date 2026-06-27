import { useEffect, type RefObject } from 'react'

/**
 * While `ref`'s element overflows AND isn't scrolled to the bottom, add `has-fade-bottom` (a CSS
 * gradient on the rail then fades the last rows, signalling there's more below). Recomputes on
 * scroll, on viewport resize (ResizeObserver), and when the content changes (MutationObserver) — so
 * the fade appears/clears as the list grows, shrinks, or the pane resizes, not only on scroll.
 */
export function useOverflowFade(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const overflowing = el.scrollHeight - el.clientHeight > 1
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      el.classList.toggle('has-fade-bottom', overflowing && !atBottom)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
      mo.disconnect()
    }
  }, [ref])
}
