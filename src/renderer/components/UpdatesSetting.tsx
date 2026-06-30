import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { UpdateCheck, UpdateInfo } from '@shared/types'

// The documented manual update (README / CLAUDE.md "Update Switchboard"), shown when this copy can't
// rebuild itself (moved out of its dist/ folder).
const MANUAL_CMD = 'git pull && npm run setup'

function statusText(check: UpdateCheck | null): string {
  if (!check) return 'Checking…'
  if (check.status === 'current') return 'Up to date'
  if (check.status === 'behind') return 'Update available'
  return check.reason === 'dev'
    ? 'Dev build — updates apply to the packaged app'
    : 'Couldn’t check for updates'
}

/**
 * Self-contained Updates control for the Preferences → Application page. Owns its own state via
 * window.api (no App plumbing — it's purely main-backed). Auto-checks on mount (each time the page
 * opens). Single-button-per-state: every state surfaces exactly ONE action (or none), never a row of
 * choices. The in-app update runs only on the packaged app with its source repo findable; otherwise it
 * shows the manual command. See src/main/updater.ts.
 */
export default function UpdatesSetting(): ReactNode {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [check, setCheck] = useState<UpdateCheck | null>(null) // null = a check is in flight
  const [phase, setPhase] = useState<'idle' | 'updating' | 'done' | 'failed'>('idle')
  const [log, setLog] = useState('')
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const logRef = useRef<HTMLPreElement>(null)

  const runCheck = useCallback(async (): Promise<void> => {
    setCheck(null)
    const result = await window.api.checkForUpdates()
    if (mounted.current) setCheck(result)
  }, [])

  // Auto-check on mount (the page opening). getUpdateInfo is one-shot; runCheck hits the network.
  useEffect(() => {
    mounted.current = true
    void window.api.getUpdateInfo().then((i) => {
      if (mounted.current) setInfo(i)
    })
    void runCheck()
    return () => {
      mounted.current = false
    }
  }, [runCheck])

  // Keep the streamed log pinned to its newest line.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const update = useCallback(async (): Promise<void> => {
    setPhase('updating')
    setLog('')
    const off = window.api.onUpdateProgress((line) => {
      if (mounted.current) setLog((prev) => prev + line)
    })
    const result = await window.api.runUpdate()
    off()
    if (mounted.current) setPhase(result.ok ? 'done' : 'failed')
  }, [])

  const copyCmd = useCallback((): void => {
    void navigator.clipboard.writeText(MANUAL_CMD)
    setCopied(true)
    window.setTimeout(() => {
      if (mounted.current) setCopied(false)
    }, 1200)
  }, [])

  // Self-update needs the source repo (always found in production; in `npm run dev` too — runUpdate
  // itself is gated to the packaged app in main, so clicking in dev just reports that).
  const canSelfUpdate = !!info?.repoRoot
  const detached = phase === 'idle' && check?.status === 'behind' && !canSelfUpdate
  const showLog = phase === 'updating' || phase === 'done' || phase === 'failed'

  // Exactly one action per state (or none).
  const btn = (label: string, onClick: () => void): ReactNode => (
    <button type="button" className="sb-setting-btn" onClick={onClick}>
      {label}
    </button>
  )
  let button: ReactNode = null
  if (phase === 'done') button = btn('Relaunch', () => window.api.relaunchForUpdate())
  else if (phase === 'failed') button = btn('Try again', () => void update())
  else if (phase === 'idle' && check) {
    if (check.status === 'current') button = btn('Check again', () => void runCheck())
    else if (check.status === 'behind' && canSelfUpdate) button = btn('Update now', () => void update())
    else if (detached) button = btn(copied ? 'Copied' : 'Copy command', copyCmd)
    else if (check.status === 'unknown' && check.reason !== 'dev')
      button = btn('Try again', () => void runCheck())
    // 'unknown' + dev → no button (status only)
  }
  // phase 'updating' → no button (the log carries it)

  // The status line reflects the phase (an in-flight / finished run) over the last check result.
  const displayStatus =
    phase === 'updating'
      ? 'Updating…'
      : phase === 'done'
        ? 'Update complete'
        : phase === 'failed'
          ? 'Update failed'
          : statusText(check)

  return (
    <div className="sb-setting">
      <div className="sb-setting-title">Updates</div>
      <div className="sb-update">
        <div className="sb-update-head">
          {button}
          <div className="sb-update-info">
            <span className="sb-update-version mono">
              {info ? `v${info.version} · ${info.shaShort}` : ''}
            </span>
            <span className="sb-update-status">{displayStatus}</span>
          </div>
        </div>

        {detached ? (
          <div className="sb-update-manual">
            <span className="sb-update-note">
              This app isn’t in its source folder, so it can’t update itself — run this in the repo:
            </span>
            <code className="sb-update-cmd mono">{MANUAL_CMD}</code>
          </div>
        ) : null}

        {showLog ? (
          <pre className="sb-update-log mono" ref={logRef}>
            {log}
          </pre>
        ) : null}
      </div>
      <div className="sb-setting-desc">
        Updating pulls the latest source and rebuilds the app; reopen it once to finish.
      </div>
    </div>
  )
}
