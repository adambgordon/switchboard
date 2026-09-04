import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizeTabLayout, sanitizeTabWorkspace } from '../src/shared/tabWorkspace'
import { loadTabWorkspace, TabWorkspaceStore } from '../src/main/tabWorkspaceStore'

const onePane = (ids: string[], active: string | null = ids[0] ?? null) => ({
  panes: [{ sessionIds: ids, activeSessionId: active }]
})

describe('tab workspace sanitizing', () => {
  it('keeps window, pane and tab order while removing duplicates globally', () => {
    expect(sanitizeTabWorkspace({
      version: 1,
      windows: [
        { panes: [
          { sessionIds: ['A', 'B', 'A'], activeSessionId: 'B' },
          { sessionIds: ['C'], activeSessionId: 'C' }
        ] },
        { panes: [{ sessionIds: ['B', 'D'], activeSessionId: 'B' }] }
      ]
    })).toEqual({
      version: 1,
      windows: [
        { panes: [
          { sessionIds: ['A', 'B'], activeSessionId: 'B' },
          { sessionIds: ['C'], activeSessionId: 'C' }
        ] },
        { panes: [{ sessionIds: ['D'], activeSessionId: 'D' }] }
      ]
    })
  })

  it('preserves a deliberately deselected pane and repairs an invalid active id', () => {
    expect(sanitizeTabLayout({ panes: [
      { sessionIds: ['A'], activeSessionId: null },
      { sessionIds: ['B', 'C'], activeSessionId: 'missing' }
    ] })).toEqual({ panes: [
      { sessionIds: ['A'], activeSessionId: null },
      { sessionIds: ['B', 'C'], activeSessionId: 'B' }
    ] })
  })

  it('drops malformed and empty panes and ignores panes beyond the supported split', () => {
    expect(sanitizeTabLayout({ panes: [
      { sessionIds: [], activeSessionId: null },
      { sessionIds: ['A'], activeSessionId: 'A' },
      { sessionIds: ['B'], activeSessionId: 'B' }
    ] })).toEqual({ panes: [{ sessionIds: ['A'], activeSessionId: 'A' }] })
    expect(sanitizeTabLayout({ panes: 'nope' })).toBeNull()
  })

  it('rejects unknown workspace versions', () => {
    expect(sanitizeTabWorkspace({ version: 2, windows: [onePane(['A'])] })).toEqual({
      version: 1,
      windows: []
    })
  })
})

describe('TabWorkspaceStore', () => {
  let dir: string
  const file = 'workspace-test.json'

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'sb-tab-workspace-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('coalesces rapid updates and writes the latest layouts in window order', () => {
    const store = new TabWorkspaceStore(dir, file)
    store.update(10, onePane(['A']))
    store.update(10, onePane(['A', 'B'], 'B'))
    store.update(20, onePane(['C']))
    expect(loadTabWorkspace(dir, file)).toEqual([])
    vi.runAllTimers()
    expect(loadTabWorkspace(dir, file)).toEqual([
      onePane(['A', 'B'], 'B'),
      onePane(['C'])
    ])
  })

  it('removes a normally closed window but preserves it during app quit', () => {
    const store = new TabWorkspaceStore(dir, file)
    store.register(10, onePane(['A']))
    store.close(10, true)
    store.flush()
    expect(loadTabWorkspace(dir, file)).toEqual([onePane(['A'])])

    store.close(10, false)
    store.flush()
    expect(loadTabWorkspace(dir, file)).toEqual([])
  })

  it('deduplicates corrupt cross-window ownership before writing', () => {
    const store = new TabWorkspaceStore(dir, file)
    store.register(10, onePane(['A', 'B']))
    store.register(20, onePane(['B', 'C'], 'C'))
    store.flush()
    expect(loadTabWorkspace(dir, file)).toEqual([
      onePane(['A', 'B']),
      onePane(['C'], 'C')
    ])
  })

  it('returns empty for missing or corrupt files', () => {
    expect(loadTabWorkspace(dir, file)).toEqual([])
    writeFileSync(join(dir, file), 'not json')
    expect(loadTabWorkspace(dir, file)).toEqual([])
  })
})
