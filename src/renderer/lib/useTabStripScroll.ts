import { useEffect, useLayoutEffect, type RefObject } from 'react'
import { attachAutoHide } from './useAutoHideScrollbar'
import type { TabLayout } from './tabLayoutPreference'
import { tabScrollEdges, tabWheelDelta } from './tabScroll'

function revealActive(el: HTMLElement): void {
  // A resize during a drag must not pull the strip back to the tab the user is moving away from.
  if (document.body.classList.contains('sb-dragging-tab')) return
  el.querySelector<HTMLElement>('[aria-selected="true"]')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

export function useTabStripScroll(
  ref: RefObject<HTMLElement>,
  layout: TabLayout,
  geometryKey: string,
  activeId: string | undefined
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (layout === 'scroll') el.scrollTop = 0
    else el.scrollLeft = 0

    const updateEdges = (): void => {
      const { before, after } = tabScrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth)
      el.classList.toggle('has-tabs-before', layout === 'scroll' && before)
      el.classList.toggle('has-tabs-after', layout === 'scroll' && after)
      // Chromium reserves a custom scrollbar lane even without overflow. Only wrapping uses it.
      el.classList.toggle('is-overflowing', layout === 'wrap' && el.scrollHeight - el.clientHeight > 1)
    }
    const updateGeometry = (): void => {
      updateEdges()
      revealActive(el)
      updateEdges()
    }
    const onWheel = (event: WheelEvent): void => {
      const delta = tabWheelDelta(event, el.clientWidth)
      if (!delta || el.scrollWidth - el.clientWidth <= 1) return
      event.preventDefault()
      el.scrollLeft += delta
    }

    updateGeometry()
    el.addEventListener('scroll', updateEdges, { passive: true })
    if (layout === 'scroll') el.addEventListener('wheel', onWheel, { passive: false })
    const hideScrollbar = layout === 'wrap' ? attachAutoHide(el) : undefined
    const observer = new ResizeObserver(updateGeometry)
    observer.observe(el)
    // Font loading can change tab widths without changing the viewport's dimensions.
    el.querySelectorAll('.sb-tab').forEach((tab) => observer.observe(tab))
    return () => {
      el.removeEventListener('scroll', updateEdges)
      el.removeEventListener('wheel', onWheel)
      hideScrollbar?.()
      observer.disconnect()
    }
  }, [ref, layout, geometryKey])

  // Scrolling by hand updates only the fades; activation is what brings the active tab back.
  useEffect(() => {
    if (ref.current) revealActive(ref.current)
  }, [ref, activeId])
}
