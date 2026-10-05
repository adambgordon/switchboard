import type { MouseEvent } from 'react'
import { AGENTS, type AgentKind } from '@shared/types'
import AgentLogo from './AgentLogo'
import { Compose, Folder, FolderOpen } from './icons'

interface Props {
  root: string
  label: string
  collapsed: boolean
  /** Something inside is asking or unread — the label goes heavier. */
  wantsAttention: boolean
  /** The user has hidden this folder: drawn grayed whatever the rail's filter. */
  dimmed: boolean
  onToggle: (root: string) => void
  /** Right-click: the folder's menu, at the cursor. */
  onContextMenu: (e: MouseEvent, root: string) => void
  /** The installed agents, nearest the pencil first. */
  agents: AgentKind[]
  /** The pencil: start a new conversation, choosing the agent, with this folder preselected. */
  onNew: (root: string) => void
  /** An agent's logo: folder and agent are both known, so the conversation starts at once. */
  onStart: (root: string, agent: AgentKind) => void
  /** ⇧-click on either: the same, in a new window — the pencil's chooser, or the logo's conversation.
   *  Absent while new windows are unavailable. */
  onNewInWindow?: (root: string, agent?: AgentKind) => void
}

/**
 * A folder's sticky header. A `role="group"` div rather than one button, so the per-folder actions
 * can sit beside the collapse toggle as buttons of their own — a button cannot contain buttons.
 *
 * The label stacks a hidden bold copy under the visible one, so the cell is always as wide as the
 * heavier weight: a folder going bold or plain as its sessions change never shifts anything around it.
 *
 * The new-conversation actions are one hover container: the pencil shows while the pointer is anywhere
 * in the folder, and the agent logos slide out from under it while the pointer is on the pencil or the
 * logos — so moving from the pencil to a logo never crosses a gap that would put them away.
 */
export default function SidebarGroupHeader({
  root,
  label,
  collapsed,
  wantsAttention,
  dimmed,
  onToggle,
  onContextMenu,
  agents,
  onNew,
  onStart,
  onNewInWindow
}: Props) {
  return (
    // The folder's drag handle: the header grabs the whole folder around it (useBlockReorder).
    <div
      className={`sb-group-head${dimmed ? ' dimmed' : ''}`}
      role="group"
      aria-label={label}
      data-drag=""
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e, root)
      }}
    >
      <button
        className={`sb-group-toggle${wantsAttention ? ' attention' : ''}`}
        onClick={() => onToggle(root)}
        aria-expanded={!collapsed}
      >
        {/* Both glyphs, one shown: the folder's state at rest, and the state a click would give it while
            hovered (rail.css), so the icon previews the toggle. */}
        <Folder size={15} className="sb-group-icon sb-group-icon-closed" />
        <FolderOpen size={15} className="sb-group-icon sb-group-icon-open" />
        <span className="sb-group-label">
          <span className="sb-group-label-text truncate">{label}</span>
          <span className="sb-group-label-reserve truncate" aria-hidden="true">
            {label}
          </span>
        </span>
      </button>
      {/* The pencil first, so Tab reaches it before the logos; the logos are placed around it. */}
      <div className="sb-group-new" data-no-drag="" data-tip-group="">
        <button
          className="sb-group-pencil"
          onClick={(e) => (e.shiftKey && onNewInWindow ? onNewInWindow(root) : onNew(root))}
          // The tooltip leaves the folder implied; the label names it, or every folder's pencil would
          // read the same to a screen reader.
          data-tip="New conversation"
          {...(onNewInWindow ? { 'data-tip-shift': 'New conversation in new window' } : {})}
          data-tip-slow=""
          aria-label={`New conversation in ${label}`}
        >
          <Compose size={16} />
        </button>
        {agents.map((a, i) => {
          const tip = `New ${AGENTS[a].label} conversation`
          return (
            <button
              key={a}
              className="sb-group-agent"
              // Each logo's slot, counted outward from the pencil; the slide distance derives from it.
              style={{ '--slot': i + 1 } as React.CSSProperties}
              onClick={(e) => (e.shiftKey && onNewInWindow ? onNewInWindow(root, a) : onStart(root, a))}
              data-tip={tip}
              {...(onNewInWindow ? { 'data-tip-shift': `${tip} in new window` } : {})}
              data-tip-slow=""
              aria-label={`${tip} in ${label}`}
            >
              <AgentLogo agent={a} size={13} decorative />
            </button>
          )
        })}
      </div>
    </div>
  )
}
