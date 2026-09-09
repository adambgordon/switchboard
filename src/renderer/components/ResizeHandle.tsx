import type { MouseEvent as ReactMouseEvent } from 'react'

interface Props {
  /** Called during drag with the pointer delta (px) from the drag start. */
  onResize: (deltaX: number) => void
  /** Called once on release so durable state can be committed outside the pointer-rate path. */
  onResizeEnd: (deltaX: number) => void
  onResizeStart: () => void
  /** Double-click resets to the default width. */
  onReset: () => void
  ariaLabel?: string
}

/**
 * A thin vertical divider that resizes the adjacent pane on drag. Listeners live
 * on `window` so the drag keeps tracking even when the pointer moves over the
 * terminal/main pane. `body.sb-resizing` forces the col-resize cursor + disables
 * pane pointer events for the duration.
 */
export default function ResizeHandle({ onResize, onResizeEnd, onResizeStart, onReset, ariaLabel }: Props) {
  const begin = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    onResizeStart()
    document.body.classList.add('sb-resizing')

    let latest = 0
    let frame: number | null = null
    const flush = (): void => {
      frame = null
      onResize(latest)
    }
    const move = (ev: MouseEvent): void => {
      latest = ev.clientX - startX
      if (frame == null) frame = requestAnimationFrame(flush)
    }
    const end = (): void => {
      if (frame != null) cancelAnimationFrame(frame)
      onResize(latest)
      onResizeEnd(latest)
      document.body.classList.remove('sb-resizing')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', end)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', end)
  }

  return (
    <div
      className="sb-resize-handle"
      onMouseDown={begin}
      onDoubleClick={onReset}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
    />
  )
}
