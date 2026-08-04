import type { PtyState } from '../../shared/types'

const AGENT_VIEW_PREFIX = 'agent-view:'

/** The conversation a PTY currently stands for, or null when it stands for none. */
export function conversationIdForPty(pty: PtyState): string | null {
  return pty.surface.kind === 'conversation' ? pty.surface.sessionId : null
}

export function surfaceKeyForPty(pty: PtyState): string {
  return conversationIdForPty(pty) ?? `${AGENT_VIEW_PREFIX}${pty.ptyId}`
}

export function isAgentViewSurfaceKey(key: string): boolean {
  return key.startsWith(AGENT_VIEW_PREFIX)
}

export function isAgentViewHost(pty: PtyState | null | undefined): boolean {
  return !!pty && pty.surface.kind === 'agent-view-host'
}

export function shouldFollowPtySurfaceChange(
  priorKey: string | undefined,
  nextKey: string,
  selectedKey: string | null,
  priorWasTerminal: boolean
): boolean {
  return !!priorKey && priorKey !== nextKey && selectedKey === priorKey && priorWasTerminal
}

/** An Agent View host has no transcript, so it has no turn to be stale relative to. */
export function liveStartedAtForPty(pty: PtyState): number | null {
  return pty.surface.kind === 'conversation' ? pty.startedAt : null
}
