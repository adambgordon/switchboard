import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { UpdateCheck } from '@shared/types'
import type { Updates } from '../lib/useUpdates'

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

function useCyclingDots(active: boolean): string {
  const [dotCount, setDotCount] = useState(0)

  useEffect(() => {
    if (!active) {
      setDotCount(0)
      return
    }
    const id = window.setTimeout(() => setDotCount((n) => (n + 1) % 4), dotCount === 3 ? 450 : 150)
    return () => window.clearTimeout(id)
  }, [active, dotCount])

  return '.'.repeat(dotCount)
}

function UpdatingStatus({ dots }: { dots: string }): ReactNode {
  return (
    <span className="sb-update-status sb-update-status-updating">
      <span>Updating</span>
      <span className="sb-update-dots">
        <span>{dots}</span>
        <span className="sb-update-dots-measure" aria-hidden="true">...</span>
      </span>
    </span>
  )
}

interface Props {
  /** The shared self-update state, owned by App's useUpdates() so it survives this modal closing and so
   *  the launch check / attention dot can read it too. */
  updates: Updates
}

/**
 * The Updates control on the Preferences → Application page. A thin presenter over the App-owned
 * `useUpdates` state (so a launch-time check and the gear/nav attention dot share it). Single-button-
 * per-state: every state surfaces exactly ONE action (or none), never a row of choices. While a check
 * is in flight the action slot holds a disabled "Checking…" button. The in-app update runs only on the
 * packaged app with its source repo findable; otherwise it shows the manual command. See useUpdates.ts
 * and src/main/updater.ts.
 */
export default function UpdatesSetting({ updates }: Props): ReactNode {
  const { info, check, checking, phase, log, canSelfUpdate, runCheck, runUpdate, relaunch } = updates
  const [copied, setCopied] = useState(false)
  const mounted = useRef(true)
  const logRef = useRef<HTMLPreElement>(null)
  const updatingDots = useCyclingDots(phase === 'updating')

  // Re-check when the page (re)opens, but never disturb an in-flight / finished run — a re-check only
  // touches `checking`/`check`, so the gear/nav dot stays put (runCheck keeps the last result).
  useEffect(() => {
    mounted.current = true
    if (phase === 'idle' && !checking) void runCheck()
    return () => {
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount (page open), not on every tick
  }, [])

  // Keep the streamed log pinned to its newest line.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const copyCmd = useCallback((): void => {
    void navigator.clipboard.writeText(MANUAL_CMD)
    setCopied(true)
    window.setTimeout(() => {
      if (mounted.current) setCopied(false)
    }, 1200)
  }, [])

  // Self-update needs the source repo (always found in production; in `npm run dev` too — runUpdate
  // itself is gated to the packaged app in main, so clicking in dev just reports that).
  const detached = phase === 'idle' && check?.status === 'behind' && !canSelfUpdate
  // The log ("mini terminal") auto-closes once the update succeeds — only an in-flight or FAILED run
  // keeps it open (a failure needs the output to read the error).
  const showLog = phase === 'updating' || phase === 'failed'

  // Exactly one action per state (or none).
  const btn = (label: string, onClick: () => void, disabled = false): ReactNode => (
    <button type="button" className="sb-setting-btn" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  )
  let button: ReactNode = null
  if (phase === 'done') button = btn('Relaunch', () => relaunch())
  else if (phase === 'failed') button = btn('Try again', () => void runUpdate())
  else if (phase === 'idle') {
    if (checking) button = btn('Checking…', () => {}, true)
    else if (check?.status === 'current') button = btn('Check again', () => void runCheck())
    else if (check?.status === 'behind' && canSelfUpdate)
      button = btn('Download update', () => void runUpdate())
    else if (detached) button = btn(copied ? 'Copied' : 'Copy command', copyCmd)
    else if (check?.status === 'unknown' && check.reason !== 'dev')
      button = btn('Try again', () => void runCheck())
    // 'unknown' + dev → no button (status only)
  }
  // phase 'updating' → no button (the log carries it)

  // The status line reflects the phase (an in-flight / finished run) over the last check result. While
  // re-checking we keep the LAST known status visible ("Up to date" stays put) so the version/status
  // block doesn't change height and shift — the disabled "Checking…" button already signals activity,
  // and a non-empty status differs from it so it never reads twice. On the first check there's no prior
  // status (empty); .sb-update-status reserves a line's height in CSS so it doesn't shift when it fills.
  const displayStatus: ReactNode =
    phase === 'updating'
      ? <UpdatingStatus dots={updatingDots} />
      : phase === 'done'
        ? 'Update complete'
        : phase === 'failed'
          ? 'Update failed'
          : checking
            ? check
              ? statusText(check)
              : ''
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
