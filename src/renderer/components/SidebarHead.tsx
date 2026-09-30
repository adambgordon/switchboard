import type { RefObject } from 'react'
import type { SidebarMode } from '../lib/sidebarPrefs'
import { Close, CollapseAll, Compose, ExpandAll, Search } from './icons'

const MODES: { value: SidebarMode; label: string }[] = [
  { value: 'folders', label: 'Folders' },
  { value: 'all', label: 'All' }
]

interface Props {
  scrolled: boolean
  mode: SidebarMode
  onModeChange: (mode: SidebarMode) => void
  /** Collapse or expand every folder (Folders mode only). */
  onSetAllCollapsed: (collapsed: boolean) => void
  query: string
  onQueryChange: (q: string) => void
  searchRef: RefObject<HTMLInputElement>
  searchOpen: boolean
  onSearchToggle: () => void
  /** A new-conversation chooser — the same as ⌘N. */
  onNewConversation: () => void
  /** ⇧-click: the same, in a new window (⇧⌘N). Absent while new windows are unavailable. */
  onNewConversationInWindow?: () => void
}

/**
 * The band above the conversation list: how the list is grouped, search, and new conversation. It
 * carries no totals, and nothing about what needs you — that is the title bar's bell, which a window
 * with its rail hidden still shows.
 */
export default function SidebarHead({
  scrolled,
  mode,
  onModeChange,
  onSetAllCollapsed,
  query,
  onQueryChange,
  searchRef,
  searchOpen,
  onSearchToggle,
  onNewConversation,
  onNewConversationInWindow
}: Props) {
  return (
    <div className={`sb-rail-head${scrolled ? ' scrolled' : ''}`} data-tip-group="">
      <div className="sb-rail-head-top">
        <div className="sb-seg sb-rail-mode" role="radiogroup" aria-label="Group conversations">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              className={`sb-seg-btn${mode === m.value ? ' active' : ''}`}
              onClick={() => onModeChange(m.value)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="sb-rail-head-tools">
          {mode === 'folders' && (
            <>
              <button
                className="sb-rail-icon-btn"
                onClick={() => onSetAllCollapsed(true)}
                data-tip="Collapse all folders"
                aria-label="Collapse all folders"
              >
                <CollapseAll size={15} />
              </button>
              <button
                className="sb-rail-icon-btn"
                onClick={() => onSetAllCollapsed(false)}
                data-tip="Expand all folders"
                aria-label="Expand all folders"
              >
                <ExpandAll size={15} />
              </button>
            </>
          )}
          <button
            className={`sb-rail-search-btn${searchOpen ? ' open' : ''}`}
            onClick={onSearchToggle}
            data-tip={searchOpen ? 'Close search' : 'Search all conversations (⌘F)'}
            aria-label={searchOpen ? 'Close search' : 'Search all conversations'}
            aria-pressed={searchOpen}
          >
            <Search size={15} />
          </button>
          <button
            className="sb-rail-icon-btn sb-rail-new-btn"
            onClick={(e) => (e.shiftKey && onNewConversationInWindow ? onNewConversationInWindow() : onNewConversation())}
            data-tip="New conversation (⌘N)"
            {...(onNewConversationInWindow ? { 'data-tip-shift': 'New conversation in new window (⇧⌘N)' } : {})}
            aria-label="New conversation"
          >
            <Compose size={15} />
          </button>
        </div>
      </div>
      {searchOpen && (
        <div className="sb-rail-sub-row">
          <div className="sb-rail-search-box">
            <input
              ref={searchRef}
              className="sb-rail-search-input"
              placeholder="Search conversations"
              value={query}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(e) => onQueryChange(e.target.value)}
            />
            <button
              className="sb-rail-search-clear"
              onClick={onSearchToggle}
              data-tip="Close search"
              aria-label="Close search"
            >
              <Close size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
