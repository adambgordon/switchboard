import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBgJobName } from '../src/main/sessions/claudeJobs'

const SHORT = '5364d27e'

describe('readBgJobName', () => {
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

  it('returns the agent name', () => {
    job(SHORT, { state: 'working', name: 'Find retrier example in mio' })
    expect(readBgJobName(SHORT, root)).toBe('Find retrier example in mio')
  })

  it('reads the name whatever the job lifecycle state', () => {
    // The row labels a terminal whose work went into this agent; that stays true once it finishes.
    job(SHORT, { state: 'done', name: 'Find retrier example in mio' })
    expect(readBgJobName(SHORT, root)).toBe('Find retrier example in mio')
  })

  it('trims surrounding whitespace', () => {
    job(SHORT, { name: '  Padded name  ' })
    expect(readBgJobName(SHORT, root)).toBe('Padded name')
  })

  it('returns empty when the job has no name yet, so the caller can fall back', () => {
    job(SHORT, { state: 'working' })
    expect(readBgJobName(SHORT, root)).toBe('')
  })

  it('returns empty for a non-string name rather than coercing it', () => {
    job(SHORT, { name: 42 })
    expect(readBgJobName(SHORT, root)).toBe('')
  })

  it('returns empty for a missing job folder', () => {
    expect(readBgJobName(SHORT, root)).toBe('')
  })

  it('returns empty for an unparseable state file instead of throwing', () => {
    mkdirSync(join(root, SHORT), { recursive: true })
    writeFileSync(join(root, SHORT, 'state.json'), '{ not json')
    expect(readBgJobName(SHORT, root)).toBe('')
  })

  it('refuses an id that is not a job folder name', () => {
    // Guards the path join against anything that isn't a short hex id.
    expect(readBgJobName('../../etc', root)).toBe('')
    expect(readBgJobName('', root)).toBe('')
  })
})
