import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RAIL_DENSITY,
  DEFAULT_SIDEBAR_MODE,
  parseFolderCollapse,
  parseRailDensity,
  parseSidebarMode,
  withFolderCollapse
} from '../src/renderer/lib/sidebarPrefs'

describe('parseSidebarMode', () => {
  it('reads both stored modes', () => {
    expect(parseSidebarMode('all')).toBe('all')
    expect(parseSidebarMode('folders')).toBe('folders')
  })

  it('falls back to the fallback it is given, not a constant it shares with the default', () => {
    // The fallback passed differs from the shipped default, so a parser ignoring it fails here.
    const other = DEFAULT_SIDEBAR_MODE === 'folders' ? 'all' : 'folders'
    for (const raw of [null, '', 'Folders', 'groups', ' all']) expect(parseSidebarMode(raw, other)).toBe(other)
    expect(parseSidebarMode(null)).toBe(DEFAULT_SIDEBAR_MODE)
  })
})

describe('parseRailDensity', () => {
  it('reads both stored densities', () => {
    expect(parseRailDensity('compact')).toBe('compact')
    expect(parseRailDensity('spacious')).toBe('spacious')
  })

  it('falls back to the fallback it is given', () => {
    const other = DEFAULT_RAIL_DENSITY === 'compact' ? 'spacious' : 'compact'
    for (const raw of [null, '', 'dense', 'Compact']) expect(parseRailDensity(raw, other)).toBe(other)
    expect(parseRailDensity(null)).toBe(DEFAULT_RAIL_DENSITY)
  })
})

describe('parseFolderCollapse', () => {
  it('keeps both true and false, which mean different things than an absent key', () => {
    expect(parseFolderCollapse('{"/r/a":true,"/r/b":false}')).toEqual({ '/r/a': true, '/r/b': false })
  })

  it('drops non-boolean entries and reads malformed input as empty', () => {
    expect(parseFolderCollapse('{"/r/a":1,"/r/b":"true","/r/c":true}')).toEqual({ '/r/c': true })
    for (const raw of [null, '', '{', '[true]', 'true']) expect(parseFolderCollapse(raw)).toEqual({})
  })
})

describe('withFolderCollapse', () => {
  it('folds one folder into the stored map without touching the others', () => {
    const stored = Object.freeze({ '/r/a': true, '/r/b': false })
    expect(withFolderCollapse(stored, '/r/c', true)).toEqual({ '/r/a': true, '/r/b': false, '/r/c': true })
    expect(withFolderCollapse(stored, '/r/a', false)).toEqual({ '/r/a': false, '/r/b': false })
  })

  it('returns the stored map itself when nothing changes', () => {
    const stored = { '/r/a': true, '/r/b': false }
    expect(withFolderCollapse(stored, '/r/a', true)).toBe(stored)
    expect(withFolderCollapse(stored, '/r/b', false)).toBe(stored)
  })

  it('records an explicit expand for a folder that had no entry', () => {
    // Absent means "follow the automatic rule", so expanding one the rule collapses must write false.
    expect(withFolderCollapse({}, '/r/a', false)).toEqual({ '/r/a': false })
  })
})
