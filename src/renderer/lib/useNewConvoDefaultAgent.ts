import { useCallback, useEffect, useState } from 'react'
import type { AgentKind } from '@shared/types'

/**
 * The "default agent for new conversations" preference, persisted in localStorage. Mirrors
 * useNewConvoDefault (the default-DIRECTORY setting), and is a SEPARATE axis: the default directory
 * stays universal (one dir for both agents). Two independent fields so the user can turn it off
 * without losing the choice:
 *   - `agent`   — which agent ⌘N / + should start ('claude' | 'codex').
 *   - `enabled` — when true AND that agent is available, ⌘N / + skip the agent picker.
 *
 * Owned once in App (like useNewConvoDefault) — both the ⌘N handler and the Preferences UI read it.
 */
interface DefaultAgentState {
  agent: AgentKind
  enabled: boolean
}

const KEY = 'switchboard.newConvoDefaultAgent'
const DEFAULTS: DefaultAgentState = { agent: 'claude', enabled: false }

function load(): DefaultAgentState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const o = JSON.parse(raw) as Partial<DefaultAgentState>
    return {
      agent: o.agent === 'codex' ? 'codex' : 'claude',
      enabled: o.enabled === true
    }
  } catch {
    return DEFAULTS
  }
}

export interface NewConvoDefaultAgent extends DefaultAgentState {
  setAgent: (agent: AgentKind) => void
  setEnabled: (enabled: boolean) => void
}

/** Persisted default-agent preference for new conversations (agent + enabled toggle). */
export function useNewConvoDefaultAgent(): NewConvoDefaultAgent {
  const [state, setState] = useState<DefaultAgentState>(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable */
    }
  }, [state])

  const setAgent = useCallback((agent: AgentKind) => setState((s) => ({ ...s, agent })), [])
  const setEnabled = useCallback((enabled: boolean) => setState((s) => ({ ...s, enabled })), [])

  return { ...state, setAgent, setEnabled }
}
