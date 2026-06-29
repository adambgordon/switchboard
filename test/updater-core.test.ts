import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { findRepoRootFrom, interpretCompare, parseFakeUpdate } from '../src/main/updater-core'

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

describe('interpretCompare', () => {
  it('is current when not behind', () => {
    expect(interpretCompare(0)).toEqual({ status: 'current' })
  })

  it('is behind by the commit count', () => {
    expect(interpretCompare(3)).toEqual({ status: 'behind', behindBy: 3 })
  })
})

describe('parseFakeUpdate', () => {
  it('returns null when unset / empty', () => {
    expect(parseFakeUpdate(undefined)).toBeNull()
    expect(parseFakeUpdate('')).toBeNull()
    expect(parseFakeUpdate('nonsense')).toBeNull()
  })

  it('parses current / behind[:N] / unknown[:reason]', () => {
    expect(parseFakeUpdate('current')).toEqual({ status: 'current' })
    expect(parseFakeUpdate('behind:5')).toEqual({ status: 'behind', behindBy: 5 })
    expect(parseFakeUpdate('behind')).toEqual({ status: 'behind', behindBy: 1 })
    expect(parseFakeUpdate('unknown:offline')).toEqual({ status: 'unknown', reason: 'offline' })
    expect(parseFakeUpdate('unknown')).toEqual({ status: 'unknown', reason: 'forced' })
  })
})
