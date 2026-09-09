import { useCallback, useEffect, useState } from 'react'
import type { UpdateCheck, UpdateCheckState, UpdateInfo, UpdateRunPhase } from '@shared/types'
import { appendUpdateLog } from '@shared/updateLog'
import { startSnapshotSync } from './snapshotSync'

export type UpdatePhase = UpdateRunPhase

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
 * Each window consumes main's shared check and update-run state. Keeping the subscription above
 * Preferences lets the attention dot update while the modal is closed.
 */
export function useUpdates(): Updates {
  const fakeUpdating = window.fakeUpdating
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [{ check, checking }, setCheckState] = useState<UpdateCheckState>({
    check: null, checking: !fakeUpdating
  })
  const [phase, setPhase] = useState<UpdatePhase>(fakeUpdating ? 'updating' : 'idle')
  const [log, setLog] = useState(fakeUpdating ? '» Previewing update progress…\n' : '')

  const runCheck = useCallback(async (): Promise<void> => {
    await window.api.checkForUpdates(true)
  }, [])

  useEffect(() => {
    void window.api.getUpdateInfo().then(setInfo)
  }, [])

  useEffect(() => {
    if (fakeUpdating) return
    return startSnapshotSync(window.api.onUpdateCheckState, window.api.getUpdateCheckState, setCheckState)
  }, [fakeUpdating])

  useEffect(() => {
    if (fakeUpdating) return
    const offState = window.api.onUpdateRunState((state) => {
      setPhase(state.phase)
      setLog(state.log)
    })
    const offProgress = window.api.onUpdateProgress((line) => {
      setLog((current) => appendUpdateLog(current, line))
    })
    void window.api.getUpdateRunState().then((state) => {
      setPhase(state.phase)
      setLog(state.log)
    })
    return () => {
      offState()
      offProgress()
    }
  }, [fakeUpdating])

  const runUpdate = useCallback(async (): Promise<void> => {
    setPhase('updating')
    setLog('')
    const result = await window.api.runUpdate()
    setPhase(result.ok ? 'done' : 'failed')
  }, [])

  const relaunch = useCallback(() => window.api.relaunchForUpdate(), [])

  const canSelfUpdate = !!info?.repoRoot
  // Not up to date ⇒ an update is available (and not mid-run), or one finished downloading and is
  // waiting on a relaunch. A failed run still has the pending update, so it counts too.
  const needsAttention = phase === 'done' || (check?.status === 'behind' && phase !== 'updating')

  return { info, check, checking, phase, log, canSelfUpdate, needsAttention, runCheck, runUpdate, relaunch }
}
