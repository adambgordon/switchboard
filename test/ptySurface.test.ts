import { describe, expect, it } from 'vitest'
import type { PtyState } from '../src/shared/types'
import {
  conversationIdForPty,
  hasProvenConversation,
  isAgentViewHost,
  isAgentViewSurfaceKey,
  liveStartedAtForPty,
  shouldFollowPtySurfaceChange,
  surfaceKeyForPty
} from '../src/renderer/lib/ptySurface'

function pty(surface: PtyState['surface'], over: Partial<PtyState> = {}): PtyState {
  return {
    ptyId: 'pty-1',
    surface,
    agent: 'claude',
    cwd: '/repo',
    title: 'Conversation',
    status: 'idle',
    lastActivity: 20,
    startedAt: 10,
    inputRequestedAt: null,
    origin: 'new',
    provisional: false,
    ...over
  }
}

describe('PTY surface projection', () => {
  it('projects an ordinary conversation by its session id', () => {
    const value = pty({ kind: 'conversation', sessionId: 'a' })
    expect(conversationIdForPty(value)).toBe('a')
    expect(surfaceKeyForPty(value)).toBe('a')
    expect(liveStartedAtForPty(value)).toBe(10)
  })

  it('gives a host a stable PTY key but no conversation identity', () => {
    const value = pty({ kind: 'agent-view-host', controllerSessionId: 'a' })
    expect(conversationIdForPty(value)).toBeNull()
    expect(surfaceKeyForPty(value)).toBe('agent-view:pty-1')
    expect(isAgentViewSurfaceKey(surfaceKeyForPty(value))).toBe(true)
    expect(isAgentViewHost(value)).toBe(true)
    expect(liveStartedAtForPty(value)).toBeNull()
  })

  it('never projects the controller itself as the conversation on screen', () => {
    const value = pty({ kind: 'agent-view-host', controllerSessionId: 'a' })
    expect(conversationIdForPty(value)).not.toBe('a')
    expect(surfaceKeyForPty(value)).not.toBe('a')
  })

  it('treats an unbound Codex terminal as keyed but unproven', () => {
    // Its placeholder id is a real row key — that is how the row survives until binding — but nothing
    // about a transcript is proven, so liveness and the Live tally must not treat it as a conversation.
    const value = pty({ kind: 'conversation', sessionId: 'placeholder' }, { provisional: true })
    expect(conversationIdForPty(value)).toBe('placeholder')
    expect(surfaceKeyForPty(value)).toBe('placeholder')
    expect(isAgentViewSurfaceKey(surfaceKeyForPty(value))).toBe(false)
    expect(hasProvenConversation(value)).toBe(false)
  })

  it('counts only a bound conversation as proven', () => {
    expect(hasProvenConversation(pty({ kind: 'conversation', sessionId: 'a' }))).toBe(true)
    expect(hasProvenConversation(pty({ kind: 'agent-view-host', controllerSessionId: 'a' }))).toBe(
      false
    )
    expect(hasProvenConversation(null)).toBe(false)
  })

  it('follows only a changed surface whose terminal is currently selected', () => {
    expect(shouldFollowPtySurfaceChange('a', 'agent-view:pty-1', 'a', true)).toBe(true)
    expect(shouldFollowPtySurfaceChange('a', 'agent-view:pty-1', 'a', false)).toBe(false)
    expect(shouldFollowPtySurfaceChange('a', 'agent-view:pty-1', 'other', true)).toBe(false)
    expect(shouldFollowPtySurfaceChange(undefined, 'a', null, true)).toBe(false)
    expect(shouldFollowPtySurfaceChange('a', 'a', 'a', true)).toBe(false)
  })
})
