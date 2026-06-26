import { useEffect, useState } from 'react'
import type { AgentAvailability } from '@shared/types'

/**
 * Which agent CLIs are launchable (probed once in main via the login shell, cached there). Drives the
 * New menu's agent segmented control: it collapses to a single agent when only one is available.
 *
 * The probe is warmed at app start, so it has almost always resolved by the time the user opens the
 * menu. Until it does we optimistically assume BOTH are available — the neutral default avoids
 * hiding an agent the user actually has, and a spawn of a genuinely-missing binary surfaces that
 * agent's own error (acceptable per the design).
 */
const ASSUME_BOTH: AgentAvailability = { claude: true, codex: true }

export function useAgentAvailability(): AgentAvailability {
  const [avail, setAvail] = useState<AgentAvailability>(ASSUME_BOTH)
  useEffect(() => {
    let alive = true
    window.api.listAgents().then((a) => {
      if (alive) setAvail(a)
    })
    return () => {
      alive = false
    }
  }, [])
  return avail
}
