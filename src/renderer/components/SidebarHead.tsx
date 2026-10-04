import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { SidebarMode } from '../lib/sidebarPrefs'
import { NO_FILTER, RAIL_CRITERIA, type RailCriterion, type RailFilter } from '../lib/railFilter'
import { Check, Close, CollapseAll, Compose, ExpandAll, EyeOff, ListFilter, Search } from './icons'

/** Each criterion's glyph, the one its command carries elsewhere: Hide's eye, the read/unread dot. */
const CRITERION_ICON: Record<RailCriterion, ReactNode> = {
  hidden: <EyeOff size={14} />,
  live: <span className="sb-menu-dot filled" aria-hidden="true" />
}

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
  filter: RailFilter
  onFilterChange: (filter: RailFilter) => void
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
 * The filter button and its menu. Choosing a criterion keeps the menu open, so several can be set in
 * one visit; while any is set the icon is drawn heavier and in full ink, so a narrowed rail is never
 * mistaken for an empty one.
 */
function FilterMenu({ filter, onChange }: { filter: RailFilter; onChange: (filter: RailFilter) => void }) {
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!place) return
    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setPlace(null)
    }
    // The Escape that closes the menu is consumed: App's own Escape would also clear the rail's
    // search or close Find.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setPlace(null)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [place])

  const toggle = (c: RailCriterion): void => {
    const next = new Set(filter)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    onChange(next)
  }
  const active = filter.size > 0
  return (
    <>
      <button
        ref={buttonRef}
        className={`sb-rail-icon-btn sb-rail-filter-btn${place ? ' open' : ''}${active ? ' active' : ''}`}
        onClick={() => {
          if (place) return setPlace(null)
          const rect = buttonRef.current!.getBoundingClientRect()
          setPlace({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
        }}
        data-tip={
          active
            ? `Showing only: ${RAIL_CRITERIA.filter((c) => filter.has(c.id)).map((c) => c.label).join(', ')}`
            : 'Filter conversations'
        }
        aria-label="Filter conversations"
        aria-haspopup="menu"
        aria-expanded={!!place}
      >
        <ListFilter size={15} heavy={active} />
      </button>
      {place && (
        <div ref={menuRef} className="sb-ctxmenu sb-filter-menu" role="menu" style={place}>
          <div className="sb-filter-caption label-caps">Show only</div>
          {RAIL_CRITERIA.map((c) => (
            <button
              key={c.id}
              className="sb-ctxmenu-item"
              role="menuitemcheckbox"
              aria-checked={filter.has(c.id)}
              onClick={() => toggle(c.id)}
            >
              {CRITERION_ICON[c.id]}
              <span>{c.label}</span>
              {filter.has(c.id) && <Check size={13} className="sb-filter-check" />}
            </button>
          ))}
          {active && (
            <>
              <div className="sb-ctxmenu-sep" />
              <button
                className="sb-ctxmenu-item"
                role="menuitem"
                onClick={() => {
                  onChange(NO_FILTER)
                  setPlace(null)
                }}
              >
                <Close size={14} />
                <span>Clear filters</span>
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}

/**
 * The band above the conversation list: how the list is grouped, which conversations it shows, search,
 * and new conversation. It carries no totals, and nothing about what needs you — that is the title
 * bar's bell, which a window with its rail hidden still shows.
 */
export default function SidebarHead({
  scrolled,
  mode,
  onModeChange,
  onSetAllCollapsed,
  filter,
  onFilterChange,
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
          <FilterMenu filter={filter} onChange={onFilterChange} />
          <button
            className={`sb-rail-search-btn${searchOpen ? ' open' : ''}`}
            onClick={onSearchToggle}
            data-tip={searchOpen ? 'Close search' : 'Search all conversations'}
            aria-label={searchOpen ? 'Close search' : 'Search all conversations'}
            aria-pressed={searchOpen}
          >
            {/* Open, it is drawn heavier, as a set filter is, rather than pressed into a tile. */}
            <Search size={15} strokeWidth={searchOpen ? 2.4 : undefined} />
          </button>
          <button
            className="sb-rail-icon-btn sb-rail-new-btn"
            onClick={(e) => (e.shiftKey && onNewConversationInWindow ? onNewConversationInWindow() : onNewConversation())}
            data-tip="New conversation (⌘N)"
            {...(onNewConversationInWindow ? { 'data-tip-shift': 'New conversation in new window (⇧⌘N)' } : {})}
            aria-label="New conversation"
          >
            <Compose size={16} />
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
