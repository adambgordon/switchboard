import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentViewControllerFromRegistry,
  attachClaudeAgentView,
  ClaudeAgentViewMonitor,
  detachClaudeAgentView,
  enterClaudeAgentView,
  parseClaudeAttachLogLine,
  resolveClaudeAttachedJob,
  splitClaudeDebugChunk
} from '../src/main/pty/claudeAgentView'

const CONTROLLER = '6b192033-e300-4ec7-bf18-ea449d3a23cf'
const ATTACHED = '5364d27e-bc41-4d50-95a6-74e708ac6069'
const PREFIX = '2026-08-03T15:04:05.678Z [DEBUG] [FV-attach]'
const roots: string[] = []
const monitors: ClaudeAgentViewMonitor[] = []

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Agent View monitor')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function monitorFixture(hasTranscript: (sessionId: string) => Promise<boolean> = async () => true) {
  const root = mkdtempSync(join(tmpdir(), 'switchboard-agent-view-monitor-'))
  roots.push(root)
  const sessionsRoot = join(root, 'sessions')
  const jobsRoot = join(root, 'jobs')
  const debugRoot = join(root, 'debug')
  mkdirSync(sessionsRoot)
  mkdirSync(jobsRoot)
  const events: string[] = []
  const monitor = new ClaudeAgentViewMonitor({
    debugRoot,
    sessionsRoot,
    jobsRoot,
    hasTranscript,
    onHost: (ptyId) => events.push(`host:${ptyId}`),
    onAttach: (ptyId, session) => events.push(`attach:${ptyId}:${session.sessionId}`),
    onDetach: (ptyId) => events.push(`detach:${ptyId}`)
  })
  monitors.push(monitor)
  return { monitor, sessionsRoot, jobsRoot, events }
}

describe('parseClaudeAttachLogLine', () => {
  it('accepts ok or alive as a successful attachment', () => {
    expect(
      parseClaudeAttachLogLine(`${PREFIX} respawnJob 5364d27e: ok=true alive=false err=`)
    ).toEqual({ kind: 'attach', shortId: '5364d27e' })
    expect(
      parseClaudeAttachLogLine(`${PREFIX} respawnJob 5364d27e: ok=false alive=true err=already alive`)
    ).toEqual({ kind: 'attach', shortId: '5364d27e' })
  })

  it('keeps a failed respawn in host mode', () => {
    expect(
      parseClaudeAttachLogLine(`${PREFIX} respawnJob 5364d27e: ok=false alive=false err=missing`)
    ).toEqual({ kind: 'attach-failed' })
  })

  it('recognizes return to the Agent View list with CRLF', () => {
    expect(
      parseClaudeAttachLogLine(`${PREFIX} attachJob returned after 1250ms — remounting list\r`)
    ).toEqual({ kind: 'detach' })
  })

  it('fails closed on format drift or an invalid short id', () => {
    expect(parseClaudeAttachLogLine(`${PREFIX} respawnJob xyz: ok=true alive=true err=`)).toEqual({
      kind: 'unexpected'
    })
    expect(parseClaudeAttachLogLine('2026-08-03T15:04:05.678Z [DEBUG] unrelated')).toEqual({
      kind: 'unexpected'
    })
  })
})

describe('Agent View surface lifecycle', () => {
  it('preserves the controller while switching host → B → host → C', () => {
    const ordinary = { kind: 'conversation', sessionId: CONTROLLER } as const
    const host = enterClaudeAgentView(ordinary)
    expect(host).toEqual({ kind: 'agent-view-host', controllerSessionId: CONTROLLER })
    const b = attachClaudeAgentView(host, ATTACHED)
    expect(b).toEqual({
      kind: 'agent-view-host',
      controllerSessionId: CONTROLLER,
      attachedSessionId: ATTACHED
    })
    const returned = detachClaudeAgentView(b)
    expect(returned).toEqual({ kind: 'agent-view-host', controllerSessionId: CONTROLLER })
    expect(attachClaudeAgentView(returned, '71735b89-1111-2222-3333-444444444444')).toEqual({
      kind: 'agent-view-host',
      controllerSessionId: CONTROLLER,
      attachedSessionId: '71735b89-1111-2222-3333-444444444444'
    })
  })

  it('keeps partial debug lines until they are complete', () => {
    const first = splitClaudeDebugChunk('', `${PREFIX} respawnJob 5364`)
    expect(first.lines).toEqual([])
    const second = splitClaudeDebugChunk(
      first.remainder,
      'd27e: ok=true alive=true err=\nnext line\r\npartial'
    )
    expect(second.lines).toEqual([
      `${PREFIX} respawnJob 5364d27e: ok=true alive=true err=`,
      'next line\r'
    ])
    expect(second.remainder).toBe('partial')
  })
})

describe('agentViewControllerFromRegistry', () => {
  it('requires an exact interactive controller with parked provenance', () => {
    expect(
      agentViewControllerFromRegistry(
        JSON.stringify({ sessionId: CONTROLLER, kind: 'interactive', parkedJobId: '5364d27e' })
      )
    ).toBe(CONTROLLER)
  })

  it('rejects background, malformed, and unparked records', () => {
    expect(
      agentViewControllerFromRegistry(
        JSON.stringify({ sessionId: CONTROLLER, kind: 'bg', parkedJobId: '5364d27e' })
      )
    ).toBeNull()
    expect(agentViewControllerFromRegistry(JSON.stringify({ sessionId: CONTROLLER, kind: 'interactive' }))).toBeNull()
    expect(agentViewControllerFromRegistry('{bad json')).toBeNull()
    expect(
      agentViewControllerFromRegistry(
        JSON.stringify({
          sessionId: '5364d27e----------------------------',
          kind: 'interactive',
          parkedJobId: '5364d27e'
        })
      )
    ).toBeNull()
  })
})

describe('resolveClaudeAttachedJob', () => {
  function fixture(state: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'switchboard-agent-view-'))
    roots.push(root)
    mkdirSync(join(root, '5364d27e'))
    writeFileSync(join(root, '5364d27e', 'state.json'), JSON.stringify(state))
    return root
  }

  it('resolves a checked job record whose transcript exists', async () => {
    const root = fixture({
      daemonShort: '5364d27e',
      sessionId: ATTACHED,
      cwd: '/Volumes/git/switchboard',
      detail: 'Investigate Agent View identity'
    })
    await expect(resolveClaudeAttachedJob('5364d27e', root, async () => true)).resolves.toEqual({
      sessionId: ATTACHED,
      cwd: '/Volumes/git/switchboard',
      title: 'Investigate Agent View identity'
    })
  })

  it('rejects mismatched identity and a missing transcript', async () => {
    const wrong = fixture({
      daemonShort: 'otherjob',
      sessionId: ATTACHED,
      cwd: '/Volumes/git/switchboard'
    })
    await expect(resolveClaudeAttachedJob('5364d27e', wrong, async () => true)).resolves.toBeNull()

    const missing = fixture({
      daemonShort: '5364d27e',
      sessionId: ATTACHED,
      cwd: '/Volumes/git/switchboard'
    })
    await expect(resolveClaudeAttachedJob('5364d27e', missing, async () => false)).resolves.toBeNull()

    const malformed = fixture({
      daemonShort: '5364d27e',
      sessionId: '5364d27e----------------------------',
      cwd: '/Volumes/git/switchboard'
    })
    await expect(resolveClaudeAttachedJob('5364d27e', malformed, async () => true)).resolves.toBeNull()
  })
})

describe('ClaudeAgentViewMonitor', () => {
  it('does not turn an ordinary Claude session into a host on unexpected debug output', async () => {
    const { monitor, events } = monitorFixture()
    const debugFile = monitor.register('pty-ordinary', CONTROLLER)
    expect(debugFile).toBeTruthy()
    appendFileSync(debugFile!, '2026-08-03T15:04:05.678Z [DEBUG] unrelated\n')

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(events).toEqual([])
  })

  it('holds valid lifecycle output until the registry proves the controller', async () => {
    const { monitor, sessionsRoot, jobsRoot, events } = monitorFixture()
    mkdirSync(join(jobsRoot, '5364d27e'))
    writeFileSync(
      join(jobsRoot, '5364d27e', 'state.json'),
      JSON.stringify({
        daemonShort: '5364d27e',
        sessionId: ATTACHED,
        cwd: '/Volumes/git/switchboard'
      })
    )
    const debugFile = monitor.register('pty-pending', CONTROLLER)
    appendFileSync(
      debugFile!,
      `${PREFIX} respawnJob 5364d27e: ok=true alive=true err=\n`
    )

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(events).toEqual([])

    writeFileSync(
      join(sessionsRoot, '12345.json'),
      JSON.stringify({ sessionId: CONTROLLER, kind: 'interactive', parkedJobId: '5364d27e' })
    )
    await waitFor(() => events.includes(`attach:pty-pending:${ATTACHED}`))
  })

  it('retries transient transcript evidence while the attachment remains current', async () => {
    let attempts = 0
    const { monitor, sessionsRoot, jobsRoot, events } = monitorFixture(async () => ++attempts >= 2)
    writeFileSync(
      join(sessionsRoot, '12345.json'),
      JSON.stringify({ sessionId: CONTROLLER, kind: 'interactive', parkedJobId: '5364d27e' })
    )
    mkdirSync(join(jobsRoot, '5364d27e'))
    writeFileSync(
      join(jobsRoot, '5364d27e', 'state.json'),
      JSON.stringify({
        daemonShort: '5364d27e',
        sessionId: ATTACHED,
        cwd: '/Volumes/git/switchboard'
      })
    )
    const debugFile = monitor.register('pty-retry', CONTROLLER)
    await waitFor(() => events.includes('host:pty-retry'))
    appendFileSync(
      debugFile!,
      `${PREFIX} respawnJob 5364d27e: ok=true alive=true err=\n`
    )

    await waitFor(() => events.includes(`attach:pty-retry:${ATTACHED}`))
    expect(attempts).toBe(2)
  })

  it('fails a proven host back to its unattached surface on debug format drift', async () => {
    const { monitor, sessionsRoot, jobsRoot, events } = monitorFixture()
    writeFileSync(
      join(sessionsRoot, '12345.json'),
      JSON.stringify({ sessionId: CONTROLLER, kind: 'interactive', parkedJobId: '5364d27e' })
    )
    mkdirSync(join(jobsRoot, '5364d27e'))
    writeFileSync(
      join(jobsRoot, '5364d27e', 'state.json'),
      JSON.stringify({
        daemonShort: '5364d27e',
        sessionId: ATTACHED,
        cwd: '/Volumes/git/switchboard'
      })
    )
    const debugFile = monitor.register('pty-host', CONTROLLER)
    expect(debugFile).toBeTruthy()
    await waitFor(() => events.includes('host:pty-host'))

    appendFileSync(
      debugFile!,
      `${PREFIX} respawnJob 5364d27e: ok=true alive=true err=\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(events).toContain(`attach:pty-host:${ATTACHED}`)
    const beforeDrift = events.length

    appendFileSync(debugFile!, '2026-08-03T15:04:05.678Z [DEBUG] format changed\n')
    await waitFor(() => events.slice(beforeDrift).includes('detach:pty-host'))
    expect(events.at(-1)).toBe('detach:pty-host')
  })

  it('forgets registry proof after the owning PID record disappears', async () => {
    const { monitor, sessionsRoot, events } = monitorFixture()
    const registry = join(sessionsRoot, '12345.json')
    writeFileSync(
      registry,
      JSON.stringify({ sessionId: CONTROLLER, kind: 'interactive', parkedJobId: '5364d27e' })
    )
    monitor.register('pty-first', CONTROLLER)
    await waitFor(() => events.includes('host:pty-first'))
    monitor.unregister('pty-first')
    unlinkSync(registry)
    await new Promise((resolve) => setTimeout(resolve, 350))

    monitor.register('pty-later', CONTROLLER)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(events).not.toContain('host:pty-later')
  })

  it('cancels a pending attachment before an already-written detach can resolve', async () => {
    let releaseTranscript!: () => void
    let startedTranscript!: () => void
    const transcriptStarted = new Promise<void>((resolve) => {
      startedTranscript = resolve
    })
    const transcriptReleased = new Promise<void>((resolve) => {
      releaseTranscript = resolve
    })
    const { monitor, sessionsRoot, jobsRoot, events } = monitorFixture(async () => {
      startedTranscript()
      await transcriptReleased
      return true
    })
    writeFileSync(
      join(sessionsRoot, '12345.json'),
      JSON.stringify({ sessionId: CONTROLLER, kind: 'interactive', parkedJobId: '5364d27e' })
    )
    mkdirSync(join(jobsRoot, '5364d27e'))
    writeFileSync(
      join(jobsRoot, '5364d27e', 'state.json'),
      JSON.stringify({
        daemonShort: '5364d27e',
        sessionId: ATTACHED,
        cwd: '/Volumes/git/switchboard'
      })
    )
    const debugFile = monitor.register('pty-race', CONTROLLER)
    appendFileSync(
      debugFile!,
      `${PREFIX} respawnJob 5364d27e: ok=true alive=true err=\n` +
        `${PREFIX} attachJob returned after 10ms — remounting list\n`
    )

    await transcriptStarted
    await waitFor(() => events.includes('detach:pty-race'))
    releaseTranscript()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(events).not.toContain(`attach:pty-race:${ATTACHED}`)
  })

  it('keeps debug cleanup failures out of unregister', () => {
    const { monitor } = monitorFixture()
    const debugFile = monitor.register('pty-cleanup', CONTROLLER)
    unlinkSync(debugFile!)
    mkdirSync(debugFile!)
    writeFileSync(join(debugFile!, 'block-removal'), '')

    expect(() => monitor.unregister('pty-cleanup')).not.toThrow()
  })

  it('preserves an old run directory while its encoded PID is alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'switchboard-agent-view-cleanup-'))
    roots.push(root)
    const sessionsRoot = join(root, 'sessions')
    const jobsRoot = join(root, 'jobs')
    const debugRoot = join(root, 'debug')
    mkdirSync(sessionsRoot)
    mkdirSync(jobsRoot)
    mkdirSync(debugRoot)
    const liveRun = join(debugRoot, `run-${process.pid}-still-live`)
    const deadRun = join(debugRoot, 'run-2147483647-dead')
    mkdirSync(liveRun)
    mkdirSync(deadRun)
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(liveRun, old, old)
    utimesSync(deadRun, old, old)

    const monitor = new ClaudeAgentViewMonitor({
      debugRoot,
      sessionsRoot,
      jobsRoot,
      hasTranscript: async () => true,
      onHost: () => {},
      onAttach: () => {},
      onDetach: () => {}
    })
    monitors.push(monitor)

    expect(existsSync(liveRun)).toBe(true)
    expect(existsSync(deadRun)).toBe(false)
  })
})
