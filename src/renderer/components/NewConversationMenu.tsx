import { useEffect, useRef } from 'react'
import { Folder, Plus } from './icons'
import { basename } from '../lib/format'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'

interface Props {
  open: boolean
  recentDirs: string[]
  onChoose: (cwd: string) => void
  onPickOther: () => void
  onClose: () => void
}

export default function NewConversationMenu({ open, recentDirs, onChoose, onPickOther, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The recent-dirs list reveals its scrollbar only while scrolling (matches the rail), not at rest.
  useAutoHideScrollbar(listRef)

  useEffect(() => {
    if (!open) return
    const el = ref.current
    const items = (): HTMLButtonElement[] =>
      Array.from(el?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

    // Move focus into the menu so the arrow keys + Enter drive it immediately,
    // whether it was opened by ⌘N or by clicking New.
    items()[0]?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      const list = items()
      if (list.length === 0) return
      const idx = list.findIndex((b) => b === document.activeElement)
      // Roving focus over the items. stopPropagation keeps App's window-level
      // list-nav (↑/↓) and Enter-to-resume from also firing behind the menu — this
      // document keydown listener sits below window in the bubble path, so stopping
      // here means the event never reaches App's window handler.
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        list[idx < 0 ? 0 : (idx + 1) % list.length].focus()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        list[idx < 0 ? list.length - 1 : (idx - 1 + list.length) % list.length].focus()
      } else if (e.key === 'Home') {
        e.preventDefault()
        e.stopPropagation()
        list[0].focus()
      } else if (e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        list[list.length - 1].focus()
      } else if (e.key === 'Enter' || e.key === ' ') {
        // The focused button activates natively (a separate click event); only stop
        // App's global Enter handler from resuming the selected conversation too.
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* Dismiss backdrop: a transparent, full-window layer that catches the click-away
          everywhere — crucially over the title bar, whose -webkit-app-region: drag swallows
          DOM mouse events (so a document mousedown listener never fired there). no-drag lets
          it receive the click; it sits just below the menu's z-index. */}
      <div className="sb-newmenu-backdrop" onClick={onClose} />
      <div className="sb-newmenu" ref={ref} role="menu">
        <div className="sb-newmenu-head label-caps">New conversation in…</div>
        <div className="sb-newmenu-list sb-autoscroll" ref={listRef}>
          {recentDirs.length === 0 && <div className="sb-newmenu-empty mono">No recent directories</div>}
          {recentDirs.map((d) => (
            <button key={d} className="sb-newmenu-item" onClick={() => onChoose(d)} role="menuitem">
              <Folder size={14} className="sb-newmenu-folder" />
              <span className="sb-newmenu-name truncate">{basename(d)}</span>
              <span className="sb-newmenu-path mono truncate">{d}</span>
            </button>
          ))}
        </div>
        <button className="sb-newmenu-other" onClick={onPickOther} role="menuitem">
          <Plus size={14} />
          <span>Choose another folder…</span>
        </button>
      </div>
    </>
  )
}
