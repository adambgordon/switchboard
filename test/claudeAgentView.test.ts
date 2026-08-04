import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ClaudeAgentViewMonitor,
  agentViewControllerFromRegistry,
  enterClaudeAgentView,
  exitClaudeAgentView
} from '../src/main/pty/claudeAgentView'

const A = '6b192033-e300-4ec7-bf18-ea449d3a23cf'
const B = '5364d27e-bc41-4d50-95a6-74e708ac6069'

function record(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 4242,
    sessionId: A,
    kind: 'interactive',
    parkedJobId: '5364d27e',
    ...over
  })
}

describe('agentViewControllerFromRegistry', () => {
  it('accepts an interactive record carrying a parked job', () => {
    expect(agentViewControllerFromRegistry(record())).toEqual({ sessionId: A, pid: 4242 })
  })

  it('rejects a record with no parked job — that session is not in Agent View', () => {
    expect(agentViewControllerFromRegistry(record({ parkedJobId: undefined }))).toBeNull()
  })

  it('rejects a non-interactive record', () => {
    expect(agentViewControllerFromRegistry(record({ kind: 'daemon' }))).toBeNull()
  })

  it('rejects malformed ids rather than trusting them', () => {
    expect(agentViewControllerFromRegistry(record({ sessionId: 'nope' }))).toBeNull()
    expect(agentViewControllerFromRegistry(record({ parkedJobId: 'XYZ' }))).toBeNull()
    expect(agentViewControllerFromRegistry(record({ pid: 0 }))).toBeNull()
    expect(agentViewControllerFromRegistry(record({ pid: 1.5 }))).toBeNull()
  })

  it('returns null on unparseable text instead of throwing', () => {
    expect(agentViewControllerFromRegistry('{')).toBeNull()
    expect(agentViewControllerFromRegistry('')).toBeNull()
  })
})

describe('surface transitions', () => {
  it('turns a conversation into a host keyed by its controller', () => {
    expect(enterClaudeAgentView({ kind: 'conversation', sessionId: A })).toEqual({
      kind: 'agent-view-host',
      controllerSessionId: A
    })
  })

  it('restores the controller conversation on exit', () => {
    expect(exitClaudeAgentView({ kind: 'agent-view-host', controllerSessionId: A })).toEqual({
      kind: 'conversation',
      sessionId: A
    })
  })

  it('round-trips without inventing a different identity', () => {
    const start = { kind: 'conversation', sessionId: A } as const
    expect(exitClaudeAgentView(enterClaudeAgentView(start))).toEqual(start)
  })

  it('leaves a plain conversation alone on exit', () => {
    const conv = { kind: 'conversation', sessionId: B } as const
    expect(exitClaudeAgentView(conv)).toBe(conv)
  })
})

describe('ClaudeAgentViewMonitor', () => {
  let root: string
  let monitor: ClaudeAgentViewMonitor | null
  let hosted: string[]
  let exited: string[]
  let alive: Set<number>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-agentview-'))
    hosted = []
    exited = []
    alive = new Set([4242])
    monitor = null
  })

  afterEach(() => {
    monitor?.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  function build(): ClaudeAgentViewMonitor {
    monitor = new ClaudeAgentViewMonitor({
      sessionsRoot: root,
      isProcessAlive: (pid) => alive.has(pid),
      onHost: (ptyId) => hosted.push(ptyId),
      onExit: (ptyId) => exited.push(ptyId)
    })
    return monitor
  }

  it('reports a PTY already in Agent View as soon as it registers', () => {
    writeFileSync(join(root, '4242.json'), record())
    build().register('pty-1', A)
    expect(hosted).toEqual(['pty-1'])
    expect(exited).toEqual([])
  })

  it('leaves an ordinary Claude PTY alone', () => {
    writeFileSync(join(root, '4242.json'), record({ parkedJobId: undefined }))
    build().register('pty-1', A)
    expect(hosted).toEqual([])
  })

  it('does not host a PTY because some other session is in Agent View', () => {
    writeFileSync(join(root, '4242.json'), record())
    build().register('pty-1', B)
    expect(hosted).toEqual([])
  })

  it('ignores a record whose process is gone, so a resumed id inherits nothing', () => {
    // Claude leaves the registry file behind on exit — observed against a real killed session.
    alive.clear()
    writeFileSync(join(root, '4242.json'), record())
    build().register('pty-1', A)
    expect(hosted).toEqual([])
  })

  it('reports leaving Agent View once the parked job is cleared', () => {
    const file = join(root, '4242.json')
    writeFileSync(file, record())
    const m = build()
    m.register('pty-1', A)
    expect(hosted).toEqual(['pty-1'])

    writeFileSync(file, record({ parkedJobId: undefined }))
    m.register('pty-2', B)
    expect(exited).toEqual(['pty-1'])
  })

  it('reports a transition once, not on every refresh', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    expect(hosted).toEqual(['pty-1'])

    m.register('pty-2', B)
    expect(hosted).toEqual(['pty-1'])
    expect(exited).toEqual([])
  })

  it('holds state when the registry is unreadable rather than reporting a false exit', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    expect(hosted).toEqual(['pty-1'])

    rmSync(root, { recursive: true, force: true })
    m.register('pty-2', B)
    expect(exited).toEqual([])
  })

  it('skips one unreadable record without hiding a valid one', () => {
    writeFileSync(join(root, 'bad.json'), '{ not json')
    writeFileSync(join(root, '4242.json'), record())
    build().register('pty-1', A)
    expect(hosted).toEqual(['pty-1'])
  })

  it('stops reporting for a PTY once it unregisters', () => {
    const file = join(root, '4242.json')
    writeFileSync(file, record())
    const m = build()
    m.register('pty-1', A)
    m.unregister('pty-1')

    writeFileSync(file, record({ parkedJobId: undefined }))
    m.register('pty-2', B)
    expect(exited).toEqual([])
  })
})
