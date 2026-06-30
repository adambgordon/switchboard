import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { findRepoRootFrom, interpretRemoteSha, parseFakeUpdate } from '../src/main/updater-core'

const here = dirname(fileURLToPath(import.meta.url)) // <repo>/test
const repoRoot = resolve(here, '..') // <repo> — has .git + package.json name "switchboard"

describe('findRepoRootFrom', () => {
  it('walks up to the switchboard repo root', () => {
    expect(findRepoRootFrom(here)).toBe(repoRoot)
  })

  it('returns null when the repo is beyond maxDepth', () => {
    // depth 1 only inspects `here` (test/), which lacks the repo markers; the root one level up is
    // never reached.
    expect(findRepoRootFrom(here, 1)).toBeNull()
  })

  it('returns null when no matching ancestor exists', () => {
    expect(findRepoRootFrom('/')).toBeNull()
  })
})

describe('interpretRemoteSha', () => {
  it('is current when the build SHA matches the remote tip', () => {
    expect(interpretRemoteSha('abc123def', 'abc123def')).toEqual({ status: 'current' })
  })

  it('matches by prefix (short vs full SHA), case-insensitively', () => {
    expect(interpretRemoteSha('abc123', 'abc123def4567')).toEqual({ status: 'current' })
    expect(interpretRemoteSha('ABC123', 'abc123')).toEqual({ status: 'current' })
  })

  it('is behind when the SHAs differ', () => {
    expect(interpretRemoteSha('abc123', 'def456')).toEqual({ status: 'behind' })
  })

  it('is unknown when the remote SHA is empty', () => {
    expect(interpretRemoteSha('abc123', '')).toEqual({ status: 'unknown', reason: 'no remote sha' })
  })
})

describe('parseFakeUpdate', () => {
  it('returns null when unset / empty', () => {
    expect(parseFakeUpdate(undefined)).toBeNull()
    expect(parseFakeUpdate('')).toBeNull()
    expect(parseFakeUpdate('nonsense')).toBeNull()
  })

  it('parses current / behind / unknown[:reason]', () => {
    expect(parseFakeUpdate('current')).toEqual({ status: 'current' })
    expect(parseFakeUpdate('behind')).toEqual({ status: 'behind' })
    expect(parseFakeUpdate('behind:5')).toEqual({ status: 'behind' }) // trailing :N tolerated, ignored
    expect(parseFakeUpdate('unknown:offline')).toEqual({ status: 'unknown', reason: 'offline' })
    expect(parseFakeUpdate('unknown')).toEqual({ status: 'unknown', reason: 'forced' })
  })
})
