import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readRunningBgJobs, runningBgJobFor } from '../src/main/sessions/claudeJobs'

const SHORT = '5364d27e'
const FULL = '5364d27e-bc41-4d50-95a6-74e708ac6069'

describe('readRunningBgJobs', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-jobs-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function job(shortId: string, state: Record<string, unknown> | null): void {
    mkdirSync(join(root, shortId), { recursive: true })
    if (state) writeFileSync(join(root, shortId, 'state.json'), JSON.stringify(state))
  }

  it('returns a working job with its session id and start time', () => {
    job(SHORT, { state: 'working', sessionId: FULL, createdAt: '2026-08-04T22:09:15.741Z' })
    expect(readRunningBgJobs(root)).toEqual([
      { shortId: SHORT, sessionId: FULL, startedAt: Date.parse('2026-08-04T22:09:15.741Z') }
    ])
  })

  it('counts a blocked job as running — it is parked on a question, not finished', () => {
    job(SHORT, { state: 'blocked', sessionId: FULL })
    expect(readRunningBgJobs(root)).toHaveLength(1)
  })

  it.each(['done', 'failed', 'stopped'])('drops a %s job', (state) => {
    job(SHORT, { state, sessionId: FULL })
    expect(readRunningBgJobs(root)).toEqual([])
  })

  it('keeps a job whose state string this version does not recognize', () => {
    // The daemon is demonstrably tracking it, and wrongly calling live work finished is the worse
    // failure — a stale dot is visible and recoverable, a missing one is not.
    job(SHORT, { state: 'reticulating', sessionId: FULL })
    expect(readRunningBgJobs(root)).toHaveLength(1)
  })

  it('skips a folder with no state.json — that is a leftover, not a job', () => {
    // Fail-OPEN here produced permanent phantom rows that could never be dismissed.
    job(SHORT, null)
    expect(readRunningBgJobs(root)).toEqual([])
  })

  it('skips a folder whose state.json is unparseable', () => {
    mkdirSync(join(root, SHORT), { recursive: true })
    writeFileSync(join(root, SHORT, 'state.json'), '{ not json')
    expect(readRunningBgJobs(root)).toEqual([])
  })

  it('ignores non-job entries in the jobs root', () => {
    writeFileSync(join(root, 'pins.json'), '{}')
    job('.draft-xyz', { state: 'working', sessionId: FULL })
    expect(readRunningBgJobs(root)).toEqual([])
  })

  it('returns [] for a missing jobs root rather than throwing', () => {
    expect(readRunningBgJobs(join(root, 'nope'))).toEqual([])
  })

  it('reports a null start time when createdAt is absent or unparseable', () => {
    job(SHORT, { state: 'working', sessionId: FULL, createdAt: 'whenever' })
    expect(readRunningBgJobs(root)[0].startedAt).toBeNull()
  })
})

describe('runningBgJobFor', () => {
  const jobs = [{ shortId: SHORT, sessionId: FULL, startedAt: 1 }]

  it('matches on the exact session id', () => {
    expect(runningBgJobFor(jobs, FULL)?.shortId).toBe(SHORT)
  })

  it('does not match a different conversation', () => {
    expect(runningBgJobFor(jobs, '00000000-bc41-4d50-95a6-74e708ac6069')).toBeNull()
  })

  it('falls back to the short-id prefix when the state file omits the session id', () => {
    expect(runningBgJobFor([{ shortId: SHORT, sessionId: '', startedAt: null }], FULL)?.shortId).toBe(
      SHORT
    )
  })

  it('never matches an empty session id', () => {
    expect(runningBgJobFor(jobs, '')).toBeNull()
  })
})
