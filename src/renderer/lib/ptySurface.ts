import type { PtyState } from '../../shared/types'

const AGENT_VIEW_PREFIX = 'agent-view:'

export function conversationIdForPty(pty: PtyState): string | null {
  return pty.surface.kind === 'conversation'
    ? pty.surface.sessionId
    : pty.surface.attachedSessionId ?? null
}

export function surfaceKeyForPty(pty: PtyState): string {
  return conversationIdForPty(pty) ?? `${AGENT_VIEW_PREFIX}${pty.ptyId}`
}

export function isAgentViewSurfaceKey(key: string): boolean {
  return key.startsWith(AGENT_VIEW_PREFIX)
}

export function shouldFollowPtySurfaceChange(
  priorKey: string | undefined,
  nextKey: string,
  selectedKey: string | null,
  priorWasTerminal: boolean
): boolean {
  return !!priorKey && priorKey !== nextKey && selectedKey === priorKey && priorWasTerminal
}

export function isUnattachedAgentView(pty: PtyState | null | undefined): boolean {
  return !!pty && pty.surface.kind === 'agent-view-host' && pty.surface.attachedSessionId == null
}

/** A controller's spawn time says nothing about a background conversation it later attaches to. */
export function liveStartedAtForPty(pty: PtyState): number | null {
  return pty.surface.kind === 'conversation' ? pty.startedAt : null
}
