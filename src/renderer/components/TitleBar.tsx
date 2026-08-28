import { Gear, Moon, PanelLeft, SplitVertical, Sun } from './icons'
import type { ResolvedTheme } from '../lib/theme'

interface Props {
  paneCollapsed: boolean
  onTogglePane: () => void
  onHome: () => void
  /** Open the Preferences modal (App page) — the title-bar gear / ⌘,. */
  onOpenSettings: () => void
  /** The resolved theme — picks the toggle's icon (Moon in light → go dark; Sun in dark → go light). */
  resolvedTheme: ResolvedTheme
  /** Flip light ↔ dark as an explicit choice — the title-bar quick toggle. */
  onToggleTheme: () => void
  /** The app isn't up to date (update available, or downloaded-but-not-relaunched) — show a neutral
   *  ink dot on the gear. */
  updatesNeedAttention?: boolean
  /** Whether the main area is currently split into two panes. Undefined hides the control entirely
   *  (the tabs-and-split preference is off). */
  split?: boolean
  onToggleSplit?: () => void
}

export default function TitleBar({
  paneCollapsed,
  onTogglePane,
  onHome,
  onOpenSettings,
  resolvedTheme,
  onToggleTheme,
  updatesNeedAttention,
  split,
  onToggleSplit
}: Props) {
  return (
    <header className="sb-titlebar">
      <button className="sb-brand" onClick={onHome} data-tip="Back to welcome" aria-label="Back to welcome">
        <span className="sb-brand-mark" />
        <span className="sb-brand-name">Switchboard</span>
      </button>
      <button
        className={`sb-panel-toggle${paneCollapsed ? '' : ' active'}`}
        onClick={onTogglePane}
        data-tip={`${paneCollapsed ? 'Show' : 'Hide'} pane (⌘B)`}
        aria-label={`${paneCollapsed ? 'Show' : 'Hide'} pane`}
        aria-pressed={!paneCollapsed}
      >
        <PanelLeft size={16} />
      </button>
      {/* The split toggle is the sibling of the rail toggle beside it: both are window-level layout,
          so they live together here rather than in a pane header, which describes one conversation. */}
      {onToggleSplit && (
        <button
          className={`sb-panel-toggle${split ? ' active' : ''}`}
          onClick={onToggleSplit}
          data-tip={`${split ? 'Close' : 'Open'} split view (⌘\\)`}
          aria-label={`${split ? 'Close' : 'Open'} split view`}
          aria-pressed={!!split}
        >
          <SplitVertical size={16} />
        </button>
      )}
      <div className="sb-titlebar-spacer" />
      {window.devLabel && <span className="sb-titlebar-devlabel mono">{window.devLabel}</span>}
      <button
        className="sb-panel-toggle"
        onClick={onToggleTheme}
        data-tip={resolvedTheme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        aria-label={resolvedTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button
        className="sb-panel-toggle"
        onClick={onOpenSettings}
        data-tip={updatesNeedAttention ? 'Preferences (⌘,) — update available' : 'Preferences (⌘,)'}
        aria-label={updatesNeedAttention ? 'Preferences — update available' : 'Preferences'}
      >
        <Gear size={16} />
        {updatesNeedAttention && <span className="sb-attn-dot sb-attn-dot-gear" aria-hidden="true" />}
      </button>
    </header>
  )
}
