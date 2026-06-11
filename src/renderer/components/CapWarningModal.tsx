import { useEffect, useRef } from 'react'
import { Close } from './icons'

interface Props {
  /** {count, max} when the live set is at/over the cap, else null (closed). */
  capWarning: { count: number; max: number } | null
  /** Dismiss the modal. App re-arms it once the live count drops back below the threshold. */
  onDismiss: () => void
}

/**
 * Live-session capacity modal — a blocking, center-top dialog over the shared scrim (mirrors
 * SettingsModal's scrim + card) shown when the live set reaches the LRU cap (CONFIG.maxLivePtys).
 * Informational, so ink/graphite only — NO red (the cap stops only IDLE sessions, never active
 * work). Dismiss via ✕, scrim-click, or Esc (Esc is handled in App's key handler, which also makes
 * the rest of the keyboard inert while it's up — the same treatment as Preferences). App re-arms it
 * once the live count drops back below the threshold, so it returns the next time you climb into it.
 */
export default function CapWarningModal({ capWarning, onDismiss }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Move focus into the dialog on open, so it reads as modal and the focus ring isn't stranded on
  // whatever sits behind the scrim. Mirrors SettingsModal.
  useEffect(() => {
    if (capWarning) panelRef.current?.focus()
  }, [capWarning])

  if (!capWarning) return null
  const { count, max } = capWarning

  return (
    // Close only when the click lands on the scrim itself, not the card (its clicks bubble up with
    // a different target). Mirrors SettingsModal.
    <div className="sb-modal-scrim top" onClick={(e) => e.target === e.currentTarget && onDismiss()}>
      <div
        className="sb-modal sb-modal-cap"
        role="dialog"
        aria-modal="true"
        aria-label="Live-session limit"
        tabIndex={-1}
        ref={panelRef}
      >
        <div className="sb-modal-head">
          <h2 className="sb-modal-title">Live-session limit</h2>
          <button className="sb-modal-close" onClick={onDismiss} aria-label="Dismiss">
            <Close size={16} />
          </button>
        </div>
        <div className="sb-modal-body sb-cap-modal-body">
          <p className="sb-cap-modal-text">
            You have {count} live Claude sessions — Switchboard&apos;s cap is set to {max} to keep
            Claude Code processes from overwhelming your machine. Opening another tries to free a
            slot by stopping whichever session has been idle longest. Sessions still working are
            never stopped. You will never be blocked from starting a new conversation.
          </p>
          <button className="sb-cap-modal-btn" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
