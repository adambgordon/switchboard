import { describe, expect, it } from 'vitest'
import type { PtyState } from '../src/shared/types'
import {
  conversationIdForPty,
  isAgentViewHost,
  isAgentViewSurfaceKey,
  liveStartedAtForPty,
  shouldFollowPtySurfaceChange,
  surfaceKeyForPty
} from '../src/renderer/lib/ptySurface'

function pty(surface: PtyState['surface']): PtyState {
  return {
    ptyId: 'pty-1',
    surface,
    agent: 'claude',
    cwd: '/repo',
    title: 'Conversation',
    status: 'idle',
    lastActivity: 20,
    startedAt: 10,
    origin: 'new'
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

  it('follows only a changed surface whose terminal is currently selected', () => {
    expect(shouldFollowPtySurfaceChange('a', 'agent-view:pty-1', 'a', true)).toBe(true)
    expect(shouldFollowPtySurfaceChange('a', 'agent-view:pty-1', 'a', false)).toBe(false)
    expect(shouldFollowPtySurfaceChange('a', 'agent-view:pty-1', 'other', true)).toBe(false)
    expect(shouldFollowPtySurfaceChange(undefined, 'a', null, true)).toBe(false)
    expect(shouldFollowPtySurfaceChange('a', 'a', 'a', true)).toBe(false)
  })
})
