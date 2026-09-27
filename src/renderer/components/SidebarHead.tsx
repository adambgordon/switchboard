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
  /** Sessions asking or unread, app-wide. The tag exists only while this is above zero. */
  needsYou: number
  /** Focus the next session that needs you, cycling. */
  onNeedsYou: () => void
  /** Collapse or expand every folder (Folders mode only). */
  onSetAllCollapsed: (collapsed: boolean) => void
  query: string
  onQueryChange: (q: string) => void
  searchRef: RefObject<HTMLInputElement>
  searchOpen: boolean
  onSearchToggle: () => void
  /** A new-conversation chooser — the same as ⌘N. */
  onNewConversation: () => void
}

/**
 * The band above the conversation list: how the list is grouped, whether anything needs you, search,
 * and new conversation. It deliberately carries no totals — the tag is the one number, and it exists
 * only while there is something to go and look at.
 */
export default function SidebarHead({
  scrolled,
  mode,
  onModeChange,
  needsYou,
  onNeedsYou,
  onSetAllCollapsed,
  query,
  onQueryChange,
  searchRef,
  searchOpen,
  onSearchToggle,
  onNewConversation
}: Props) {
  const needsTip = `${needsYou} ${needsYou === 1 ? 'conversation needs' : 'conversations need'} you — click to go there`
  return (
    <div className={`sb-rail-head${scrolled ? ' scrolled' : ''}`}>
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
        {needsYou > 0 && (
          <button className="sb-rail-needs" onClick={onNeedsYou} data-tip={needsTip} aria-label={needsTip}>
            {needsYou}
          </button>
        )}
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
            onClick={onNewConversation}
            data-tip="New conversation (⌘N)"
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
