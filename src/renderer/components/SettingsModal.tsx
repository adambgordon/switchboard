import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Close, Folder, Info, Reset } from './icons'
import { basename } from '../lib/format'
import { AGENTS, type AgentKind } from '@shared/types'
import type { ThemeMode } from '../lib/theme'
import AgentLogo from './AgentLogo'

const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' }
]

// The info-tooltip copy for the live-sessions cap — mirrors the capacity modal, plus the
// raise-it-at-your-own-risk note the modal omits. Shown via a wide (wrapping) tooltip.
const CAP_TIP =
  "Each live session is a real agent process with its own terminal. At the limit, starting another reclaims whichever session has been idle longest — sessions still working are never stopped, and you're never blocked from starting a new one. Raising the limit means a higher cap on resource consumption: more memory, CPU, and GPU per live terminal. This is intended to prevent agent processes from overwhelming your machine. Increase at your own risk."

type Page = 'app' | 'shortcuts' | 'faq'

interface Shortcut {
  keys: string[]
  desc: string
}
interface Group {
  title: string
  items: Shortcut[]
}
interface Faq {
  q: string
  a: ReactNode
}

// The Shortcuts page mirrors the README keyboard table. ⌘Q / zoom are macOS default-menu
// shortcuts (no app code) — surfaced here because they're useful and undocumented.
const GROUPS: Group[] = [
  {
    title: 'Navigation',
    items: [
      { keys: ['⌘[', '⌘]'], desc: 'Back / forward' },
      { keys: ['⌥⌘↑', '⌥⌘↓'], desc: 'Previous / next conversation' },
      { keys: ['⏎'], desc: 'Resume conversation' }
    ]
  },
  {
    title: 'Conversations',
    items: [
      { keys: ['⌘N'], desc: 'New conversation' },
      { keys: ['⌘F'], desc: 'Search' },
      { keys: ['⇧⌘U'], desc: 'Mark the selected conversation read / unread' },
      { keys: ['⌥-click'], desc: 'Mark conversation unread' }
    ]
  },
  {
    title: 'Window & app',
    items: [
      { keys: ['⌘Q'], desc: 'Quit — ends all live sessions' },
      { keys: ['⌘B'], desc: 'Toggle the sidebar' },
      { keys: ['⌘+', '⌘−'], desc: 'Zoom in / out' },
      { keys: ['⌘0'], desc: 'Reset zoom' },
      { keys: ['⌘R'], desc: 'Refresh the terminal (does not reload)' },
      { keys: ['⌘,'], desc: 'Open Preferences' },
      { keys: ['⌘?'], desc: 'Show keyboard shortcuts' }
    ]
  }
]

// A few orientation notes for the FAQ page — the non-obvious interactions worth surfacing.
const FAQ: Faq[] = [
  {
    q: "How do I see a conversation's details?",
    a: (
      <>
        Click the conversation name at the top of the main pane, or right-click any row →{' '}
        <strong>Session details…</strong>. The panel shows the folder, branch, model, message count,
        size, token usage, and session ID.
      </>
    )
  },
  {
    q: 'How do I rename a conversation?',
    a: (
      <>
        Open <strong>Session details</strong> and edit the title in place at the top.
      </>
    )
  },
  {
    q: 'Does selecting a conversation start it?',
    a: (
      <>
        No, selecting only previews the transcript (read-only). A live agent process starts only
        when you <strong>Resume</strong> an existing conversation or start a <strong>New</strong> one.
      </>
    )
  },
  {
    q: 'What do the dots next to live conversations mean?',
    a: (
      <>
        The cobalt dot next to a live conversation tracks its turn:
        <ul className="sb-faq-legend">
          <li>
            <span className="sb-faq-dot">
              <span className="sb-dot busy" />
            </span>
            <span>
              <strong>Breathing</strong>: the agent is working
            </span>
          </li>
          <li>
            <span className="sb-faq-dot">
              <span className="sb-dot asking" />
            </span>
            <span>
              <strong>Pulsing ripple</strong>: the agent is waiting on your reply
            </span>
          </li>
          <li>
            <span className="sb-faq-dot">
              <span className="sb-dot awaiting" />
            </span>
            <span>
              <strong>Solid</strong>: the turn finished and is unread
            </span>
          </li>
          <li>
            <span className="sb-faq-dot">
              <span className="sb-dot quiet" />
            </span>
            <span>
              <strong>Hollow</strong>: finished and read
            </span>
          </li>
        </ul>
      </>
    )
  },
  {
    q: 'Where does Switchboard get its data?',
    a: (
      <>
        Everything is read from the session files your agents write. Claude Code sessions are
        stored under <code>~/.claude/projects/</code> and Codex sessions under{' '}
        <code>~/.codex/sessions/</code>. Switchboard is a viewer — it never owns your conversations.
      </>
    )
  }
]

// Render a key label, slashing any literal `0` — in --font-keys (SF Pro) a bare zero reads almost
// like an "O", so ⌘0 gets a hairline slash (drawn in CSS, see .sb-kbd-zero) to disambiguate it.
function renderKeyLabel(k: string): ReactNode {
  if (!k.includes('0')) return k
  return k.split(/(0)/).map((part, i) =>
    part === '0' ? (
      <span className="sb-kbd-zero" key={i}>
        0
      </span>
    ) : (
      part
    )
  )
}

interface Props {
  /** The open page, or null when the modal is closed. */
  page: Page | null
  onChangePage: (p: Page) => void
  onClose: () => void
  // --- App page: appearance ---
  /** The current theme mode (system / light / dark). */
  themeMode: ThemeMode
  /** Set the theme mode (from the Appearance segmented control). */
  onSetThemeMode: (mode: ThemeMode) => void
  /** Whether the macOS dock icon uses the dark variant (independent of the theme). */
  darkIcon: boolean
  /** Toggle the dark dock icon (a Light / Dark segmented control). */
  onSetDarkIcon: (value: boolean) => void
  // --- App page: default folder for new conversations ---
  /** Absolute path of the default folder ('' = none chosen). A chosen folder is always active. */
  defaultDir: string
  /** Open the native picker to choose the default folder. */
  onChooseDefaultDir: () => void
  /** Forget the default folder. */
  onClearDefaultDir: () => void
  // --- App page: default agent for new conversations ---
  /** The default-agent choice: 'none' (no default) or the agent ⌘N / + should start with. With <2
   *  agents installed this is the forced display value (the sole agent, or 'none'). */
  defaultAgentChoice: 'none' | AgentKind
  /** True when <2 agents are launchable — the control renders selected-but-disabled (no choice). */
  defaultAgentDisabled: boolean
  /** Set the default-agent choice (a tri-state segmented control, like Theme — no on/off toggle). */
  onSetDefaultAgentChoice: (value: 'none' | AgentKind) => void
  // --- App page: live-session cap ---
  /** Current max live sessions (the LRU cap). */
  maxLiveSessions: number
  /** Inclusive bounds — the slider's min / max. */
  maxLiveMin: number
  maxLiveMax: number
  /** Set the cap to an explicit value (the slider's onChange; clamped in the hook). */
  onSetMaxLive: (n: number) => void
  /** The default value; the Reset button is disabled when the cap already equals it. */
  maxLiveDefault: number
  /** Restore the cap to its default. */
  onResetMaxLive: () => void
}

/**
 * The Preferences modal — a left nav (App / Shortcuts) over the shared scrim+card. The App page holds
 * the default-folder-for-new-conversations setting (a folder + an enabled toggle); Shortcuts is the
 * former ShortcutsModal content. Open it to a specific page via `page` (⌘, / title-bar gear → app;
 * ⌘? / footer ? → shortcuts). Esc / scrim / ✕ close — Esc is handled by App's global key handler,
 * which also makes the rest of the keyboard inert while open.
 */
export default function SettingsModal({
  page,
  onChangePage,
  onClose,
  themeMode,
  onSetThemeMode,
  darkIcon,
  onSetDarkIcon,
  defaultDir,
  onChooseDefaultDir,
  onClearDefaultDir,
  defaultAgentChoice,
  defaultAgentDisabled,
  onSetDefaultAgentChoice,
  maxLiveSessions,
  maxLiveMin,
  maxLiveMax,
  maxLiveDefault,
  onSetMaxLive,
  onResetMaxLive
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)

  // When the Default-agent control is locked (only one — or no — agent installed), explain why on
  // hover. The label hangs on the group div, not the buttons, because disabled buttons get
  // `pointer-events: none` so the hover passes through to the group (native disabled buttons swallow
  // mouse events outright, which would otherwise leave the tooltip dead over them).
  const lockedAgentTip = !defaultAgentDisabled
    ? undefined
    : defaultAgentChoice === 'none'
      ? 'No agents detected on your PATH — install Claude Code or Codex to set a default.'
      : `Only ${AGENTS[defaultAgentChoice].label} is installed, so new conversations always use it. Install ${
          AGENTS[defaultAgentChoice === 'claude' ? 'codex' : 'claude'].label
        } to choose a default.`

  // Move focus into the dialog when it opens — so it reads as modal and the focus ring isn't
  // stranded on the gear / footer button sitting behind the scrim.
  useEffect(() => {
    if (page) panelRef.current?.focus()
  }, [page])

  if (!page) return null

  return (
    // Close only when the click lands on the scrim itself, not on the card (whose clicks bubble
    // up with a different target).
    <div className="sb-modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="sb-modal sb-modal-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Preferences"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="sb-modal-head">
          <h2 className="sb-modal-title">Preferences</h2>
          <button className="sb-modal-close" onClick={onClose} aria-label="Close">
            <Close size={16} />
          </button>
        </div>
        <div className="sb-settings-body">
          <nav className="sb-settings-nav">
            <button
              className={`sb-settings-nav-item${page === 'app' ? ' active' : ''}`}
              onClick={() => onChangePage('app')}
            >
              App
            </button>
            <button
              className={`sb-settings-nav-item${page === 'shortcuts' ? ' active' : ''}`}
              onClick={() => onChangePage('shortcuts')}
            >
              Shortcuts
            </button>
            <button
              className={`sb-settings-nav-item${page === 'faq' ? ' active' : ''}`}
              onClick={() => onChangePage('faq')}
            >
              FAQ
            </button>
          </nav>

          <div className={`sb-settings-page sb-page-${page}`}>
            {page === 'app' ? (
              <>
                <div className="sb-modal-group">
                  <div className="sb-setting">
                    <div className="sb-setting-title">Theme</div>
                    <div className="sb-seg" role="radiogroup" aria-label="Theme">
                      {THEME_MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          role="radio"
                          aria-checked={themeMode === m.value}
                          className={`sb-seg-btn${themeMode === m.value ? ' active' : ''}`}
                          onClick={() => onSetThemeMode(m.value)}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    <div className="sb-setting-desc">Follow the system theme, or force light or dark.</div>
                  </div>
                  <div className="sb-setting">
                    <div className="sb-setting-title">App icon</div>
                    <div className="sb-seg" role="radiogroup" aria-label="App icon">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!darkIcon}
                        className={`sb-seg-btn${!darkIcon ? ' active' : ''}`}
                        onClick={() => onSetDarkIcon(false)}
                      >
                        Light
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={darkIcon}
                        className={`sb-seg-btn${darkIcon ? ' active' : ''}`}
                        onClick={() => onSetDarkIcon(true)}
                      >
                        Dark
                      </button>
                    </div>
                    <div className="sb-setting-desc">Use a dark dock icon, independent of the app theme.</div>
                  </div>
                </div>
                <div className="sb-modal-group">
                  <div className="sb-setting">
                    <div className="sb-setting-title">
                      Maximum live sessions
                      <button
                        type="button"
                        className="sb-info"
                        data-tip={CAP_TIP}
                        data-tip-wide
                        aria-label="About the live-session limit"
                      >
                        <Info size={14} />
                      </button>
                    </div>
                    <div className="sb-slider-control">
                      <input
                        type="range"
                        className="sb-slider"
                        min={maxLiveMin}
                        max={maxLiveMax}
                        step={1}
                        value={maxLiveSessions}
                        onChange={(e) => onSetMaxLive(parseInt(e.target.value, 10))}
                        aria-label="Maximum live sessions"
                        style={
                          {
                            '--pct': `${((maxLiveSessions - maxLiveMin) / (maxLiveMax - maxLiveMin)) * 100}%`
                          } as CSSProperties
                        }
                      />
                      <span className="sb-slider-value mono">{maxLiveSessions}</span>
                      <button
                        type="button"
                        className="sb-slider-reset"
                        onClick={onResetMaxLive}
                        disabled={maxLiveSessions === maxLiveDefault}
                        data-tip={`Reset to default (${maxLiveDefault})`}
                        aria-label={`Reset to default (${maxLiveDefault})`}
                      >
                        <Reset size={14} />
                      </button>
                    </div>
                    <div className="sb-setting-desc">
                      How many conversations can run at once before Switchboard reclaims the
                      longest-idle one to make room.
                    </div>
                  </div>
                </div>
                <div className="sb-modal-group">
                  <div className="sb-setting">
                    <div className="sb-setting-title">Default agent</div>
                    <div
                      className="sb-seg"
                      role="radiogroup"
                      aria-label="Default agent"
                      aria-disabled={defaultAgentDisabled}
                      data-tip={lockedAgentTip}
                      data-tip-wide
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={defaultAgentChoice === 'none'}
                        disabled={defaultAgentDisabled}
                        className={`sb-seg-btn${defaultAgentChoice === 'none' ? ' active' : ''}`}
                        onClick={() => onSetDefaultAgentChoice('none')}
                      >
                        None
                      </button>
                      {(['claude', 'codex'] as AgentKind[]).map((a) => (
                        <button
                          key={a}
                          type="button"
                          role="radio"
                          aria-checked={defaultAgentChoice === a}
                          disabled={defaultAgentDisabled}
                          className={`sb-seg-btn${defaultAgentChoice === a ? ' active' : ''}`}
                          onClick={() => onSetDefaultAgentChoice(a)}
                        >
                          <AgentLogo agent={a} size={13} />
                          {AGENTS[a].label}
                        </button>
                      ))}
                    </div>
                    <div className="sb-setting-desc">
                      Skip the agent picker: <kbd className="sb-kbd">⌘N</kbd> and the{' '}
                      <strong>+</strong> button start new conversations with this agent.
                    </div>
                  </div>
                  <div className="sb-setting">
                    <div className="sb-setting-title">Default directory</div>
                    <div className="sb-setting-folder">
                      {defaultDir ? (
                        <>
                          <Folder size={15} className="sb-setting-folder-icon" />
                          <div className="sb-setting-folder-info">
                            <span className="sb-setting-folder-name truncate">{basename(defaultDir)}</span>
                            <span className="sb-setting-folder-path mono truncate">{defaultDir}</span>
                          </div>
                          <div className="sb-setting-actions">
                            <button className="sb-setting-btn" onClick={onChooseDefaultDir}>
                              Change…
                            </button>
                            <button className="sb-setting-btn" onClick={onClearDefaultDir}>
                              Clear
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="sb-setting-folder-empty">No folder chosen yet.</span>
                          <button className="sb-setting-btn" onClick={onChooseDefaultDir}>
                            Choose…
                          </button>
                        </>
                      )}
                    </div>
                    <div className="sb-setting-desc">
                      Skip folder selection: <kbd className="sb-kbd">⌘N</kbd> and the{' '}
                      <strong>+</strong> button start new conversations in this location
                      automatically. Right-click the <strong>+</strong> button to choose a specific
                      folder.
                    </div>
                  </div>
                </div>
              </>
            ) : page === 'shortcuts' ? (
              GROUPS.map((group) => (
                <div className="sb-modal-group" key={group.title}>
                  <div className="sb-modal-group-label">{group.title}</div>
                  <div className="sb-shortcuts">
                    {group.items.map((s) => (
                      <div className="sb-shortcut" key={s.desc}>
                        <div className="sb-shortcut-keys">
                          {s.keys.map((k) => (
                            <kbd className="sb-kbd" key={k}>
                              {renderKeyLabel(k)}
                            </kbd>
                          ))}
                        </div>
                        <div className="sb-shortcut-desc">{s.desc}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="sb-faq">
                {FAQ.map((item) => (
                  <div className="sb-faq-item" key={item.q}>
                    <div className="sb-faq-q">{item.q}</div>
                    <div className="sb-faq-a">{item.a}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
