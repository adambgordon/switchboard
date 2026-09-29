import type { ReactNode } from 'react'
import { Bell, Close, Folder, Rows, SplitVertical } from './icons'

interface Props {
  open: boolean
  onClose: () => void
  /** Tabs are off for someone who chose Off, so the section about them offers the switch. */
  tabsEnabled: boolean
  onEnableTabs: () => void
  onShowShortcuts: () => void
}

/**
 * What changed, shown once per profile the first time this version runs (see `WHATS_NEW_TASK`) and
 * reopenable from Preferences → Application. Drawn, not screenshotted: a picture of the app would be a
 * picture of someone's conversations.
 */
export default function WhatsNewModal({ open, onClose, tabsEnabled, onEnableTabs, onShowShortcuts }: Props) {
  if (!open) return null
  return (
    <div className="sb-modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sb-modal sb-modal-whatsnew" role="dialog" aria-modal="true" aria-label="What's new">
        <div className="sb-modal-head">
          <h2 className="sb-modal-title">What’s new in Switchboard</h2>
          <button className="sb-modal-close" onClick={onClose} aria-label="Close">
            <Close size={16} />
          </button>
        </div>
        <div className="sb-modal-body sb-whatsnew-body">
          <p className="sb-whatsnew-again">Want to find this again? Preferences → Application.</p>
          <Section icon={<SplitVertical size={18} />} title="Tabs and split view">
            Keep several conversations open as tabs. Clicking one previews it in a tab; double-click,
            resume, or type to keep it. Tabs can be dragged, multi-selected, opened in split view and new
            windows, and reopened after closing. Right-click on a tab to open a menu and see the{' '}
            <button className="sb-whatsnew-link" onClick={onShowShortcuts}>
              keyboard shortcuts
            </button>{' '}
            for more. Your tabs are always preserved, even when you quit or update the app. Choose whether
            a full tab strip wraps or scrolls in Preferences → Appearance.
            {!tabsEnabled && (
              <button className="sb-setting-btn sb-whatsnew-action" onClick={onEnableTabs}>
                Turn on tabs
              </button>
            )}
          </Section>
          <Section icon={<Rows size={18} />} title="A compact sidebar">
            Conversations take one line each; hover one for its preview, folder and last activity. Prefer
            more detail? Switch to Spacious in Preferences → Appearance → Sidebar.
          </Section>
          <Section icon={<Folder size={18} />} title="Folders">
            Conversations are grouped by project folder, with pinned ones at the top of each. Collapse
            folders, drag them into your own order, or switch to All for a single list.
          </Section>
          <Section icon={<Bell size={18} />} title="The bell">
            The bell in the top right shows what needs you. It pulses when an agent is waiting on your
            answer and turns solid when a turn has finished unread. Hover it to see them all and jump
            straight in.
          </Section>
        </div>
        <div className="sb-whatsnew-foot">
          <button className="sb-whatsnew-done" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="sb-whatsnew-item">
      <span className="sb-whatsnew-icon">{icon}</span>
      <div className="sb-whatsnew-text">
        <div className="sb-whatsnew-title">{title}</div>
        <div className="sb-whatsnew-desc">{children}</div>
      </div>
    </div>
  )
}
