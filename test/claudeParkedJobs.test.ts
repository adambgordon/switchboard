import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClaudeSessionStatus } from '../src/shared/types'
import {
  CONFIRM_AFTER_MS,
  ClaudeParkedJobMonitor,
  parkedJobFromRegistry,
  sessionStatusFromRegistry,
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

/**
 * Claude's own account of what a session is doing — the only first-party activity signal either
 * agent publishes, and the only one that catches a subagent running inside a session whose own
 * transcript stays unwritten.
 *
 * Read out of the SAME record as the parked marker but accepting a different set of them, which is
 * why this is a second function rather than a wider version of the first: most records carry a
 * status and no `parkedJobId`. Every rejection below matters in one direction only — a record wrongly
 * read as `busy` protects its terminal for as long as its process lives.
 */
describe('sessionStatusFromRegistry', () => {
  it('reads busy and idle off an interactive record', () => {
    expect(sessionStatusFromRegistry(record({ status: 'busy' }))).toEqual({
      sessionId: A,
      pid: 4242,
      status: 'busy'
    })
    expect(sessionStatusFromRegistry(record({ status: 'idle' }))?.status).toBe('idle')
  })

  it('reads a record that carries no parked marker at all', () => {
    // The common shape, and the one the parked parser rejects. Asserted explicitly because reusing
    // that parser would have made every ordinary session statusless.
    const plain = record({ parkedJobId: undefined, status: 'busy' })
    expect(parkedJobFromRegistry(plain)).toBeNull()
    expect(sessionStatusFromRegistry(plain)?.status).toBe('busy')
  })

  it('rejects an unrecognised status rather than guessing at it', () => {
    // Mapping an unknown value onto `busy` is how a session becomes permanently unreclaimable.
    expect(sessionStatusFromRegistry(record({ status: 'thinking' }))).toBeNull()
    expect(sessionStatusFromRegistry(record({ status: undefined }))).toBeNull()
    expect(sessionStatusFromRegistry(record({ status: true }))).toBeNull()
  })

  it('rejects a record whose identity or process cannot be trusted', () => {
    expect(sessionStatusFromRegistry(record({ status: 'busy', kind: 'bg' }))).toBeNull()
    expect(sessionStatusFromRegistry(record({ status: 'busy', sessionId: 'nope' }))).toBeNull()
    expect(sessionStatusFromRegistry(record({ status: 'busy', pid: 0 }))).toBeNull()
  })

  it('returns null on unparseable text instead of throwing', () => {
    expect(sessionStatusFromRegistry('{')).toBeNull()
  })
})

describe('ClaudeParkedJobMonitor', () => {
  let root: string
  let monitor: ClaudeParkedJobMonitor | null
  let changes: Array<[string, ParkedJob | null]>
  let statuses: Array<[string, ClaudeSessionStatus | null]>
  let alive: Set<number>
  /** What `readBgJobName` would return right now — Claude writes the name after the fact. */
  let jobName: string
  let clock: number
  let nth: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-parked-'))
    changes = []
    statuses = []
    alive = new Set([4242])
    jobName = 'Find the retry helper example'
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
      onChange: (ptyId, parked) => changes.push([ptyId, parked]),
      onStatus: (ptyId, status) => statuses.push([ptyId, status])
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

  /**
   * Status reports for one PTY. `observeAgain` drives a pass by registering ANOTHER terminal, and
   * each of those correctly reports its own first `null` — so asserting on the whole log would be
   * asserting on the driving mechanism rather than on the PTY under test.
   */
  function statusesOf(ptyId: string): Array<ClaudeSessionStatus | null> {
    return statuses.filter(([id]) => id === ptyId).map(([, status]) => status)
  }

  it('reports the session status immediately, with no confirmation window', () => {
    // Deliberately unlike the parked marker. That window exists to stop a row TITLE flashing while
    // two slower paths race; this value has no such race, and delaying it by CONFIRM_AFTER_MS would
    // be sixty times the latency of the watch that delivers it.
    writeFileSync(join(root, '4242.json'), record({ status: 'busy' }))
    const m = build()
    m.register('pty-1', A)
    expect(statusesOf('pty-1')).toEqual(['busy'])
    // ...and the marker in the same record is still holding its window, which is what makes this a
    // test of the two paths being independent rather than of ordering.
    expect(changes).toEqual([])
  })

  it('emits only when the status changes', () => {
    // Every pass would otherwise rebroadcast identical state, and each emit re-renders every row in
    // every window. Asserted across passes that change nothing AND a pass that changes it back.
    writeFileSync(join(root, '4242.json'), record({ status: 'busy' }))
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    observeAgain(m)
    expect(statusesOf('pty-1')).toEqual(['busy'])
    writeFileSync(join(root, '4242.json'), record({ status: 'idle' }))
    observeAgain(m)
    observeAgain(m)
    expect(statusesOf('pty-1')).toEqual(['busy', 'idle'])
  })

  it('reports no status for a record whose process is gone', () => {
    // Claude leaves the record behind when a session dies, so its final `busy` would otherwise
    // protect a terminal that is doing nothing at all.
    writeFileSync(join(root, '4242.json'), record({ status: 'busy' }))
    const m = build()
    m.register('pty-1', A)
    expect(statusesOf('pty-1')).toEqual(['busy'])
    alive.delete(4242)
    observeAgain(m)
    expect(statusesOf('pty-1')).toEqual(['busy', null])
  })

  it('reports null once, not on every pass, for a session with no record', () => {
    // `null` is a claim too — "nothing backs this" — and must be distinguishable from never having
    // reported, or the first genuine absence is swallowed.
    const m = build()
    m.register('pty-1', A)
    observeAgain(m)
    expect(statusesOf('pty-1')).toEqual([null])
  })

  it('reports the parked agent, with its name, once confirmed', () => {
    writeFileSync(join(root, '4242.json'), record())
    const m = build()
    m.register('pty-1', A)
    // The first sighting is deliberately not enough — see CONFIRM_AFTER_MS.
    expect(changes).toEqual([])
    settle(m)
    expect(changes).toEqual([['pty-1', { shortId: SHORT, name: 'Find the retry helper example' }]])
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
    expect(changes).toEqual([['pty-1', { shortId: 'ab12cd34', name: 'Find the retry helper example' }]])
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
    // Claude leaves the registry file behind when a session dies — observed in practice.
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
