import { useCallback, useEffect, useState } from 'react'
import type { UpdateCheck, UpdateInfo } from '@shared/types'

export type UpdatePhase = 'idle' | 'updating' | 'done' | 'failed'

export interface Updates {
  /** Build identity (version + sha + whether this copy can self-update). One-shot, fetched on mount. */
  info: UpdateInfo | null
  /** The latest check result; null until the first check resolves. Kept across re-checks (see runCheck). */
  check: UpdateCheck | null
  /** True while a check is in flight — drives the "Checking…" affordance without blanking `check`. */
  checking: boolean
  /** The update run's lifecycle. */
  phase: UpdatePhase
  /** Streamed output of an in-flight / finished update run. */
  log: string
  /** This copy can rebuild itself (its source repo is findable). */
  canSelfUpdate: boolean
  /** The app is not currently up to date: an update is available, or one was downloaded but not yet
   *  relaunched. Drives the attention dot on the gear + the Application nav row. */
  needsAttention: boolean
  runCheck: () => Promise<void>
  runUpdate: () => Promise<void>
  relaunch: () => void
}

/**
 * The self-update lifecycle, owned ONCE by App (not by the Preferences modal). Lifting it here — out of
 * the old self-contained UpdatesSetting — is what lets the check run at launch (so the attention dot can
 * appear before you ever open Preferences) and lets the "downloaded, awaiting relaunch" state survive the
 * modal closing. UpdatesSetting now just renders this state. The main-backed engine is src/main/updater.ts.
 */
export function useUpdates(): Updates {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [check, setCheck] = useState<UpdateCheck | null>(null)
  const [checking, setChecking] = useState(true) // the launch check fires immediately
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [log, setLog] = useState('')

  // Re-check without blanking the last result, so the attention dot stays stable across a re-check
  // (a brief null would make the dot flicker off and back on).
  const runCheck = useCallback(async (): Promise<void> => {
    setChecking(true)
    const result = await window.api.checkForUpdates()
    setCheck(result)
    setChecking(false)
  }, [])

  // At launch: fetch the one-shot build info and run the first check. App never unmounts, so no
  // mounted-guard is needed (unlike the old in-modal version).
  useEffect(() => {
    void window.api.getUpdateInfo().then(setInfo)
    void runCheck()
  }, [runCheck])

  const runUpdate = useCallback(async (): Promise<void> => {
    setPhase('updating')
    setLog('')
    const off = window.api.onUpdateProgress((line) => setLog((prev) => prev + line))
    const result = await window.api.runUpdate()
    off()
    setPhase(result.ok ? 'done' : 'failed')
  }, [])

  const relaunch = useCallback(() => window.api.relaunchForUpdate(), [])

  const canSelfUpdate = !!info?.repoRoot
  // Not up to date ⇒ an update is available (and not mid-run), or one finished downloading and is
  // waiting on a relaunch. A failed run still has the pending update, so it counts too.
  const needsAttention = phase === 'done' || (check?.status === 'behind' && phase !== 'updating')

  return { info, check, checking, phase, log, canSelfUpdate, needsAttention, runCheck, runUpdate, relaunch }
}
