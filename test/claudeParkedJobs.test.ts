import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ClaudeParkedJobMonitor,
  parkedJobFromRegistry,
  type ParkedJob
} from '../src/main/pty/claudeParkedJobs'

const A = '6aa9d622-7904-479f-99c5-343458067a72'
const B = '5364d27e-bc41-4d50-95a6-74e708ac6069'
const SHORT = '6e76e54b'

function record(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 4242,
    sessionId: A,
    kind: 'interactive',
    parkedJobId: SHORT,
    ...over
  })
}

describe('parkedJobFromRegistry', () => {
  it('reads the marker off an interactive record', () => {
    expect(parkedJobFromRegistry(record())).toEqual({ sessionId: A, pid: 4242, shortId: SHORT })
  })

  it('returns null when the session has launched no background agent', () => {
    expect(parkedJobFromRegistry(record({ parkedJobId: undefined }))).toBeNull()
  })

  it('rejects a non-interactive record', () => {
    expect(parkedJobFromRegistry(record({ kind: 'bg' }))).toBeNull()
  })

  it('rejects malformed ids rather than trusting them', () => {
    expect(parkedJobFromRegistry(record({ sessionId: 'nope' }))).toBeNull()
    expect(parkedJobFromRegistry(record({ parkedJobId: 'zz' }))).toBeNull()
    expect(parkedJobFromRegistry(record({ pid: 0 }))).toBeNull()
  })

  it('returns null on unparseable text instead of throwing', () => {
    expect(parkedJobFromRegistry('{')).toBeNull()
  })
})

describe('ClaudeParkedJobMonitor', () => {
  let root: string
  let monitor: ClaudeParkedJobMonitor | null
  let changes: Array<[string, ParkedJob | null]>
  let alive: Set<number>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-parked-'))
    changes = []
    alive = new Set([4242])
    monitor = null
  })

  afterEach(() => {
    monitor?.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  function build(): ClaudeParkedJobMonitor {
    monitor = new ClaudeParkedJobMonitor({
      sessionsRoot: root,
      isProcessAlive: (pid) => alive.has(pid),
      resolveJobName: () => 'Find retrier example in mio',
      onChange: (ptyId, parked) => changes.push([ptyId, parked])
    })
    return monitor
  }

  /** Each register() runs one refresh, which is how a second observation is driven synchronously. */
  function observeAgain(m: ClaudeParkedJobMonitor): void {
    m.register('pty-other', B)
  }

  it('reports the parked agent, with its name, once confirmed', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    // One observation is deliberately not enough — see CONFIRM_OBSERVATIONS.
    expect(changes).toEqual([])
    observeAgain(m)
    expect(changes).toEqual([['pty-1', { shortId: SHORT, name: 'Find retrier example in mio' }]])
  })

  it('never reports for a session that launched no background agent', () => {
    writeFileSync(join(root, '4242.json'), record({ parkedJobId: undefined }))
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    expect(changes).toEqual([])
  })

  it('does not attribute another session marker to this PTY', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', B)
    observeAgain(m)
    expect(changes.filter(([ptyId]) => ptyId === 'pty-1')).toEqual([])
  })

  it('ignores a record whose process is gone, so a resumed id inherits nothing', () => {
    // Claude leaves the registry file behind when a session dies — observed on a real machine.
    alive.clear()
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    expect(changes).toEqual([])
  })

  it('reports a confirmed marker only once, not on every refresh', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    expect(changes).toHaveLength(1)
    m.register('pty-third', B)
    expect(changes).toHaveLength(1)
  })

  it('holds state when the registry is unreadable rather than reporting a false clear', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    expect(changes).toHaveLength(1)

    rmSync(root, { recursive: true, force: true })
    m.register('pty-fourth', B)
    expect(changes).toHaveLength(1)
  })

  it('skips one unreadable record without hiding a valid one', () => {
    writeFileSync(join(root, 'bad.json'), '{ not json')
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    expect(changes).toHaveLength(1)
  })

  it('stops reporting for a PTY once it unregisters', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    m.unregister('pty-1')
    observeAgain(m)
    expect(changes).toEqual([])
  })
})
