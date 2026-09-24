import { Folder, FolderOpen } from './icons'

interface Props {
  root: string
  label: string
  collapsed: boolean
  /** Something inside is asking or unread — the label goes heavier. */
  wantsAttention: boolean
  onToggle: (root: string) => void
}

/**
 * A folder's sticky header. A `role="group"` div rather than one button, so the per-folder actions
 * can sit beside the collapse toggle as buttons of their own — a button cannot contain buttons.
 *
 * The label stacks a hidden bold copy under the visible one, so the cell is always as wide as the
 * heavier weight: a folder going bold or plain as its sessions change never shifts anything around it.
 */
export default function SidebarGroupHeader({ root, label, collapsed, wantsAttention, onToggle }: Props) {
  return (
    <div className="sb-group-head" role="group" aria-label={label}>
      <button
        className={`sb-group-toggle${wantsAttention ? ' attention' : ''}`}
        onClick={() => onToggle(root)}
        aria-expanded={!collapsed}
      >
        {collapsed ? <Folder size={15} className="sb-group-icon" /> : <FolderOpen size={15} className="sb-group-icon" />}
        <span className="sb-group-label">
          <span className="sb-group-label-text truncate">{label}</span>
          <span className="sb-group-label-reserve truncate" aria-hidden="true">
            {label}
          </span>
        </span>
      </button>
    </div>
  )
}
