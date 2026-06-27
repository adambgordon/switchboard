import { useEffect, useRef, useState } from 'react'
import { AGENTS, type AgentKind } from '@shared/types'
import { Folder, Plus } from './icons'
import { basename } from '../lib/format'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'
import AgentLogo from './AgentLogo'

interface Props {
  open: boolean
  recentDirs: string[]
  /** The default folder ('' = none). When set it's pinned to the top of the list, tagged, and focused
   *  on open — so a ⌘N with a default directory but no default agent opens the menu with the folder
   *  already preselected (pick the agent, press Enter). */
  defaultDir: string
  /** Agents to offer in the segmented control. With <2 the control is hidden (auto-collapse) and
   *  everything commits with the selected agent — single-agent users get the exact pre-Codex flow. */
  agents: AgentKind[]
  /** The agent the menu opens to (an enabled default, else the sticky last pick). */
  initialAgent: AgentKind
  /** Report a segment pick back to App so the sticky last-pick tracks it. */
  onAgentChange: (agent: AgentKind) => void
  onChoose: (cwd: string, agent: AgentKind) => void
  onPickOther: (agent: AgentKind) => void
  onClose: () => void
}

export default function NewConversationMenu({
  open,
  recentDirs,
  defaultDir,
  agents,
  initialAgent,
  onAgentChange,
  onChoose,
  onPickOther,
  onClose
}: Props) {
  // The default folder (when set) is pinned first and deduped from the recents, so it's the focused
  // item on open (items()[0]) — Enter commits it without re-picking the directory.
  const dirs = defaultDir ? [defaultDir, ...recentDirs.filter((d) => d !== defaultDir)] : recentDirs
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The recent-dirs list reveals its scrollbar only while scrolling (matches the rail), not at rest.
  useAutoHideScrollbar(listRef)

  // The menu's own selection. Reset to `initialAgent` each time it OPENS (so an enabled default wins
  // on every open), but freely overridable within that open. Keyed on `open` ONLY — not initialAgent
  // — so picking an agent mid-open (which updates the upstream sticky value, changing initialAgent)
  // doesn't snap the selection back. onAgentChange keeps the sticky last-pick in sync upstream.
  const [agent, setAgent] = useState<AgentKind>(initialAgent)
  useEffect(() => {
    if (open) setAgent(initialAgent)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open-transition only
  }, [open])
  const pickAgent = (a: AgentKind): void => {
    setAgent(a)
    onAgentChange(a)
  }
  // Read the live agent through a ref so the keydown listener (registered once per open) cycles from
  // the current value without re-subscribing on every switch.
  const agentRef = useRef(agent)
  agentRef.current = agent

  const showSegment = agents.length >= 2

  // Focus the first menu item (the pinned default folder, else the first recent) ONCE when the menu
  // opens, so arrows + Enter drive it immediately. Keyed on `open` only — doing this inside the
  // keydown effect below re-fired it on every re-render (an agent switch re-creates App's inline
  // onClose), which jumped the directory selection back to the top of the list.
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const el = ref.current
    const items = (): HTMLButtonElement[] =>
      Array.from(el?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

    const cycleAgent = (delta: 1 | -1): void => {
      if (agents.length < 2) return
      const i = agents.indexOf(agentRef.current)
      const next = agents[(i + delta + agents.length) % agents.length]
      setAgent(next)
      onAgentChange(next)
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (showSegment && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        e.stopPropagation()
        cycleAgent(e.key === 'ArrowRight' ? 1 : -1)
        return
      }
      const list = items()
      if (list.length === 0) return
      const idx = list.findIndex((b) => b === document.activeElement)
      // Roving focus over the dir items. stopPropagation keeps App's window-level list-nav (↑/↓) and
      // Enter-to-resume from also firing behind the menu — this document listener sits below window in
      // the bubble path, so stopping here means the event never reaches App's window handler.
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
        // The focused button activates natively (a separate click event); only stop App's global
        // Enter handler from resuming the selected conversation too.
        e.stopPropagation()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose, onAgentChange, showSegment, agents])

  if (!open) return null

  return (
    <>
      {/* Dismiss backdrop: a transparent, full-window layer that catches the click-away everywhere —
          crucially over the title bar, whose -webkit-app-region: drag swallows DOM mouse events (so a
          document mousedown listener never fired there). no-drag lets it receive the click; it sits
          just below the menu's z-index. */}
      <div className="sb-newmenu-backdrop" onClick={onClose} />
      <div className="sb-newmenu" ref={ref} role="menu">
        {showSegment && (
          <div className="sb-newmenu-agents sb-seg" role="radiogroup" aria-label="Agent">
            {agents.map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={agent === a}
                className={`sb-seg-btn sb-newmenu-agent${agent === a ? ' active' : ''}`}
                // Don't let the segment grab focus from the directory row — switching agent must not
                // clear the directory selection (which row Enter commits / shows as focused).
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickAgent(a)}
              >
                <AgentLogo agent={a} size={13} />
                <span>{AGENTS[a].label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="sb-newmenu-head label-caps">New conversation in…</div>
        <div className="sb-newmenu-list sb-autoscroll" ref={listRef}>
          {dirs.length === 0 && <div className="sb-newmenu-empty mono">No recent directories</div>}
          {dirs.map((d) => (
            <button
              key={d}
              className={`sb-newmenu-item${d === defaultDir ? ' selected' : ''}`}
              onClick={() => onChoose(d, agent)}
              role="menuitem"
              aria-current={d === defaultDir ? 'true' : undefined}
            >
              <Folder size={14} className="sb-newmenu-folder" />
              <span className="sb-newmenu-name truncate">{basename(d)}</span>
              <span className="sb-newmenu-path mono truncate">{d}</span>
            </button>
          ))}
        </div>
        <button className="sb-newmenu-other" onClick={() => onPickOther(agent)} role="menuitem">
          <Plus size={14} />
          <span>Choose another folder…</span>
        </button>
      </div>
    </>
  )
}
