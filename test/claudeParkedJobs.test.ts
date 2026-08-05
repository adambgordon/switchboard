import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONFIRM_AFTER_MS,
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
  /** What `readBgJobName` would return right now — Claude writes the name after the fact. */
  let jobName: string
  let clock: number
  let nth: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-parked-'))
    changes = []
    alive = new Set([4242])
    jobName = 'Find retrier example in mio'
    clock = 1_000_000
    nth = 0
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
      resolveJobName: () => jobName,
      now: () => clock,
      onChange: (ptyId, parked) => changes.push([ptyId, parked])
    })
    return monitor
  }

  /**
   * Drive one more refresh without moving the clock, the way production does when an unrelated Claude
   * terminal registers. This is the path that used to satisfy the old two-observation counter
   * instantly; a fresh id each time so it registers rather than replacing.
   */
  function observeAgain(m: ClaudeParkedJobMonitor): void {
    m.register(`pty-other-${nth++}`, B)
  }

  /** Let the confirmation window elapse, then observe — how a marker legitimately gets reported. */
  function settle(m: ClaudeParkedJobMonitor): void {
    clock += CONFIRM_AFTER_MS
    observeAgain(m)
  }

  it('reports the parked agent, with its name, once confirmed', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    // The first sighting is deliberately not enough — see CONFIRM_AFTER_MS.
    expect(changes).toEqual([])
    settle(m)
    expect(changes).toEqual([['pty-1', { shortId: SHORT, name: 'Find retrier example in mio' }]])
  })

  it('does not confirm on a second observation that costs no time', () => {
    // The regression. Confirmation used to be a COUNT of observations, and `refresh()` runs on every
    // register(), so an unrelated Claude terminal opening in the same millisecond supplied the second
    // observation for free — reporting the marker well inside the ~600 ms the transcript needs to be
    // indexed, which is the flash the window exists to prevent.
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    observeAgain(m)
    observeAgain(m)
    expect(changes).toEqual([])
  })

  it('waits out the full window, to the millisecond', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    clock += CONFIRM_AFTER_MS - 1
    observeAgain(m)
    expect(changes).toEqual([])
    clock += 1
    observeAgain(m)
    expect(changes).toHaveLength(1)
  })

  it('restarts the window when the marker changes to a different agent', () => {
    // A marker that has only just appeared has had no time to be contradicted, whatever the previous
    // one had accrued — so the clock cannot be inherited across a change.
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    clock += CONFIRM_AFTER_MS - 1
    writeFileSync(join(root, '4242.json'), record({ parkedJobId: 'ab12cd34' }))
    observeAgain(m)
    expect(changes).toEqual([])
    clock += 1
    observeAgain(m)
    expect(changes).toEqual([])
    settle(m)
    expect(changes).toEqual([['pty-1', { shortId: 'ab12cd34', name: 'Find retrier example in mio' }]])
  })

  it('never reports for a session that launched no background agent', () => {
    writeFileSync(join(root, '4242.json'), record({ parkedJobId: undefined }))
    const m = build()
    m.register('pty-1', A)
    settle(m)
    expect(changes).toEqual([])
  })

  it('does not attribute another session marker to this PTY', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', B)
    settle(m)
    expect(changes.filter(([ptyId]) => ptyId === 'pty-1')).toEqual([])
  })

  it('ignores a record whose process is gone, so a resumed id inherits nothing', () => {
    // Claude leaves the registry file behind when a session dies — observed on a real machine.
    alive.clear()
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    settle(m)
    expect(changes).toEqual([])
  })

  it('keeps looking for a name Claude has not written yet, and re-emits when it appears', () => {
    // `nameSource` is `auto`, so the name is generated after the fact and the first read is routinely
    // empty. Resolving once would leave the row on its fallback title for the life of the terminal.
    jobName = ''
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    settle(m)
    expect(changes).toEqual([['pty-1', { shortId: SHORT, name: '' }]])

    jobName = 'Named later'
    observeAgain(m)
    expect(changes[1]).toEqual(['pty-1', { shortId: SHORT, name: 'Named later' }])
  })

  it('stops resolving once a name is known', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    settle(m)
    expect(changes).toHaveLength(1)

    jobName = 'Renamed'
    observeAgain(m)
    expect(changes).toHaveLength(1)
  })

  it('reports a confirmed marker only once, not on every refresh', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    settle(m)
    expect(changes).toHaveLength(1)
    observeAgain(m)
    expect(changes).toHaveLength(1)
  })

  it('holds state when the registry is unreadable rather than reporting a false clear', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    settle(m)
    expect(changes).toHaveLength(1)

    rmSync(root, { recursive: true, force: true })
    observeAgain(m)
    expect(changes).toHaveLength(1)
  })

  it('skips one unreadable record without hiding a valid one', () => {
    writeFileSync(join(root, 'bad.json'), '{ not json')
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    settle(m)
    expect(changes).toHaveLength(1)
  })

  it('stops reporting for a PTY once it unregisters', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    m.unregister('pty-1')
    settle(m)
    expect(changes).toEqual([])
  })
})
