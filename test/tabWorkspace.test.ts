import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_RESTORED_WINDOWS,
  sanitizeTabLayout,
  sanitizeTabWorkspace
} from '../src/shared/tabWorkspace'
import {
  loadTabWorkspace,
  TabWorkspaceStore,
  writeTabWorkspaceFile
} from '../src/main/tabWorkspaceStore'

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

  // Panes were already bounded; windows were not. Every surviving entry becomes a real
  // BrowserWindow at startup, so a truncated write or hand edit could bury the app under windows
  // with no way back. Uses distinct ids per window so the global dedup cannot be what trims the
  // list — otherwise this would pass even with no cap at all.
  it('caps how many windows a corrupt workspace can reopen', () => {
    const many = Array.from({ length: 40 }, (_, i) => onePane([`S${i}`]))
    const kept = sanitizeTabWorkspace({ version: 1, windows: many }).windows

    expect(kept).toHaveLength(MAX_RESTORED_WINDOWS)
    // Keeps the FIRST entries, so restoration is a prefix of what was saved rather than a sample.
    expect(kept[0]).toEqual(onePane(['S0']))
    expect(kept[MAX_RESTORED_WINDOWS - 1]).toEqual(onePane([`S${MAX_RESTORED_WINDOWS - 1}`]))
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

  it('keeps satellite layouts dormant until the primary activates them', async () => {
    const restored = [onePane(['A']), onePane(['B']), onePane(['C'])]
    const store = new TabWorkspaceStore(dir, file, restored)
    const primary = store.takePrimary()
    expect(primary).toEqual(onePane(['A']))
    store.register(10, primary)

    expect(store.layoutFor(10)).toEqual(onePane(['A']))
    expect(store.snapshot()).toEqual(restored)
    expect(await store.takeDormant(Promise.resolve(), () => true)).toEqual([onePane(['B']), onePane(['C'])])
    expect(await store.takeDormant(Promise.resolve(), () => true)).toEqual([])

    store.register(20, onePane(['B']))
    store.register(30, onePane(['C']))
    expect(store.snapshot()).toEqual(restored)
  })

  it('excludes recognized ids from active and dormant layouts and rejects stale reports', async () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['A', 'H', 'B'], 'H'), onePane(['J']), onePane(['unknown'])])
    store.register(10, store.takePrimary())
    store.excludeSessions(new Set(['H', 'J']))
    expect(store.layoutFor(10)).toEqual(onePane(['A', 'B'], 'B'))
    expect(await store.takeDormant(Promise.resolve(), () => true)).toEqual([onePane(['unknown'])])
    store.update(10, onePane(['A', 'H', 'B'], 'H'))
    store.register(20, onePane(['J']))
    expect(store.layoutFor(20)).toBeNull()
    vi.runAllTimers()
    expect(loadTabWorkspace(dir, file)).toEqual([onePane(['A', 'B'], 'B')])
  })

  it('persists all-hidden removal but performs no write for an unaffected workspace', () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['H'])])
    store.register(10, store.takePrimary())
    store.excludeSessions(new Set(['H']))
    vi.runAllTimers()
    expect(loadTabWorkspace(dir, file)).toEqual([])
    expect(store.layoutFor(10)).toBeNull()
    store.excludeSessions(new Set(['H', 'J']))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for indexing before consuming the current filtered satellite layouts', async () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['A']), onePane(['H']), onePane(['B', 'J', 'unknown'], 'J')])
    store.register(10, store.takePrimary())
    let ready = (): void => {}
    const indexing = new Promise<void>((resolve) => { ready = resolve })
    let settled = false
    const restoration = store.takeDormant(indexing, () => true).then((layouts) => {
      settled = true
      return layouts
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(store.snapshot()).toEqual([onePane(['A']), onePane(['H']), onePane(['B', 'J', 'unknown'], 'J')])
    store.excludeSessions(new Set(['H', 'J']))
    ready()
    expect(await restoration).toEqual([onePane(['B', 'unknown'], 'unknown')])
  })

  it('honors a workspace clear while activation waits for indexing', async () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['A']), onePane(['B'])])
    store.register(10, store.takePrimary())
    let ready = (): void => {}
    const restoration = store.takeDormant(new Promise<void>((resolve) => { ready = resolve }), () => true)
    store.clear()
    ready()
    expect(await restoration).toEqual([])
    expect(store.snapshot()).toEqual([])
  })

  it('consumes satellites once when multiple activation requests await the same index', async () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['B']), onePane(['C'])])
    let ready = (): void => {}
    const indexing = new Promise<void>((resolve) => { ready = resolve })
    const first = store.takeDormant(indexing, () => true)
    const second = store.takeDormant(indexing, () => true)
    ready()
    expect(await first).toEqual([onePane(['B']), onePane(['C'])])
    expect(await second).toEqual([])
  })

  it('checks cancellation after readiness and preserves layouts for a later valid request', async () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['B'])])
    let active = true
    let ready = (): void => {}
    const restoration = store.takeDormant(new Promise<void>((resolve) => { ready = resolve }), () => active)
    active = false
    ready()
    expect(await restoration).toEqual([])
    expect(store.snapshot()).toEqual([onePane(['B'])])
    expect(await store.takeDormant(Promise.resolve(), () => true)).toEqual([onePane(['B'])])
  })

  it('retains dormant layouts when indexing fails and allows a later retry', async () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['B'])])
    expect(await store.takeDormant(Promise.reject(new Error('index unavailable')), () => true)).toEqual([])
    expect(store.snapshot()).toEqual([onePane(['B'])])
    expect(await store.takeDormant(Promise.resolve(), () => true)).toEqual([onePane(['B'])])
  })

  it('clears registered and dormant layouts together on explicit disable', () => {
    const store = new TabWorkspaceStore(dir, file, [onePane(['A']), onePane(['B'])])
    const primary = store.takePrimary()
    store.register(10, primary)
    store.clear()
    expect(store.snapshot()).toEqual([])
    expect(loadTabWorkspace(dir, file)).toEqual([])
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

  it('prefers the authoritative owner when duplicate live layouts overlap during a move', () => {
    const owners = new Map([['B', 20]])
    const store = new TabWorkspaceStore(dir, file, [], (id) => owners.get(id))
    store.register(10, onePane(['A', 'B'], 'B'))
    store.register(20, onePane(['B', 'C'], 'B'))
    expect(store.snapshot()).toEqual([
      onePane(['A'], 'A'),
      onePane(['B', 'C'], 'B')
    ])
  })

  it('keeps the first occurrence when the authoritative owner has not persisted the tab yet', () => {
    const store = new TabWorkspaceStore(dir, file, [], () => 20)
    store.register(10, onePane(['A', 'B'], 'B'))
    store.register(20, onePane(['C']))
    expect(store.snapshot()).toEqual([
      onePane(['A', 'B'], 'B'),
      onePane(['C'])
    ])
  })

  it('preserves the last good workspace when the temporary write fails', () => {
    const target = join(dir, file)
    writeFileSync(target, JSON.stringify({ version: 1, windows: [onePane(['GOOD'])] }))
    mkdirSync(`${target}.tmp`)
    expect(writeTabWorkspaceFile(
      target,
      JSON.stringify({ version: 1, windows: [onePane(['NEW'])] })
    )).toBe(false)
    expect(loadTabWorkspace(dir, file)).toEqual([onePane(['GOOD'])])
  })

  it('returns empty for missing or corrupt files', () => {
    expect(loadTabWorkspace(dir, file)).toEqual([])
    writeFileSync(join(dir, file), 'not json')
    expect(loadTabWorkspace(dir, file)).toEqual([])
  })
})
