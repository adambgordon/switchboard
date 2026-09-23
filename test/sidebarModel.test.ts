import { describe, expect, it } from 'vitest'
import type { ConversationGroup, ConversationMeta, LiveState, PtyState } from '../src/shared/types'
import {
  buildSidebar,
  conversationSeed,
  folderLabels,
  visibleRows,
  type SidebarInput,
  type SidebarModel
} from '../src/renderer/lib/sidebarModel'

const T = 1_780_000_000_000

function conv(sessionId: string, start: number | null, over: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    sessionId,
    agent: 'claude',
    cwd: '/w/repo',
    title: sessionId,
    preview: '',
    gitBranch: null,
    mtime: T + 999_999,
    messageCount: 3,
    version: null,
    sizeBytes: 0,
    model: null,
    outputTokens: 0,
    inputTokens: 0,
    contextTokens: 0,
    firstActivityAt: start,
    ...over
  }
}

function group(root: string, conversations: ConversationMeta[], cwd = root): ConversationGroup {
  return { cwd, root, worktree: cwd !== root, exists: true, label: cwd, conversations, latestMtime: 0 }
}

function pty(sessionId: string, over: Partial<PtyState> = {}): PtyState {
  return {
    ptyId: `pty-${sessionId}`,
    sessionId,
    agent: 'claude',
    cwd: '/w/repo',
    projectRoot: '/w/repo',
    title: 'New conversation',
    status: 'idle',
    lastActivity: T,
    startedAt: T,
    inputRequestedAt: null,
    origin: 'resume',
    provisional: false,
    parkedJob: null,
    registryStatus: null,
    ownedHere: true,
    ...over
  }
}

/** Live state per id; a live row with no entry is `quiet`. Non-live rows never get one. */
function states(map: Record<string, LiveState | null>): SidebarInput['liveState'] {
  return (p, _m, id) => (p ? (Object.hasOwn(map, id) ? map[id] : 'quiet') : null)
}

/** Deliberately NOT the shipped limits, so a hardcoded constant in the model fails these tests. */
const LIMITS = { folderCap: 2, allCap: 3, autoExpand: 2 }

function input(over: Partial<SidebarInput> = {}): SidebarInput {
  return {
    mode: 'folders',
    groups: [],
    ptys: [],
    pinned: [],
    hidden: new Set(),
    rowRanks: {},
    folderRanks: {},
    liveState: states({}),
    active: new Set(),
    collapsed: {},
    navExpanded: new Set(),
    revealed: {},
    search: null,
    limits: LIMITS,
    ...over
  }
}

/** The whole rendered shape: each group's key, collapse, hidden count and blocks' row ids. */
function shape(model: SidebarModel): unknown[] {
  return model.groups.map((g) => ({
    key: g.key,
    collapsed: g.collapsed,
    hidden: g.hidden,
    blocks: g.blocks.map((b) => [b.id, ...b.rows.map((r) => r.sessionId)])
  }))
}

const keys = (model: SidebarModel): string[] => model.groups.map((g) => g.key)

describe('seeds', () => {
  it('seed a conversation by its first message', () => {
    expect(conversationSeed(conv('a', T))).toBe(T)
  })

  it('fall back to the file birthtime, never to mtime, while it exists', () => {
    expect(conversationSeed(conv('a', null, { birthtimeMs: T - 5, mtime: T + 1 }))).toBe(T - 5)
    expect(conversationSeed(conv('a', null, { birthtimeMs: 0, mtime: T + 1 }))).toBe(T + 1)
    expect(conversationSeed(conv('a', null, { mtime: T + 1 }))).toBe(T + 1)
  })

  it('keep a row with no first message in place while its transcript is written', () => {
    // The regression a "harmless" `?? mtime` would reintroduce: every write would lift the row.
    const other = conv('other', T - 50)
    const build = (mtime: number): string[] =>
      visibleRows(
        buildSidebar(
          input({
            mode: 'all',
            groups: [group('/w/repo', [conv('a', null, { birthtimeMs: T - 100, mtime }), other])]
          })
        )
      ).map((r) => r.sessionId)
    expect(build(T - 90)).toEqual(['other', 'a'])
    expect(build(T + 10_000)).toEqual(['other', 'a'])
  })
})

describe('All mode', () => {
  it('is one headerless group: pins in pin order, then every other row newest-first across folders', () => {
    const model = buildSidebar(
      input({
        mode: 'all',
        groups: [
          group('/w/one', [conv('a', T - 10), conv('b', T - 40)]),
          group('/w/two', [conv('c', T - 20), conv('d', T - 30), conv('p1', T - 1), conv('p2', T - 90)])
        ],
        pinned: ['p2', 'p1']
      })
    )
    expect(model.groups.map((g) => [g.key, g.header, g.label])).toEqual([['', false, '']])
    expect(shape(model)).toEqual([
      { key: '', collapsed: false, hidden: 1, blocks: [['pin:*', 'p2', 'p1'], ['un:*', 'a', 'c', 'd']] }
    ])
  })

  it('never collapses, whatever is stored', () => {
    const model = buildSidebar(
      input({ mode: 'all', groups: [group('/w/one', [conv('a', T)])], collapsed: { '': true, '/w/one': true } })
    )
    expect(shape(model)).toEqual([{ key: '', collapsed: false, hidden: 0, blocks: [['un:*', 'a']] }])
  })

  it('uses the All cap, not the folder cap', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, i) => conv(id, T - i))
    const model = buildSidebar(input({ mode: 'all', groups: [group('/w/one', rows)] }))
    expect(shape(model)).toEqual([{ key: '', collapsed: false, hidden: 2, blocks: [['un:*', 'a', 'b', 'c']] }])
  })
})

describe('Folders mode', () => {
  it('folds worktrees and subdirectories into their project', () => {
    const model = buildSidebar(
      input({
        groups: [
          group('/w/repo', [conv('main', T - 30)]),
          group('/w/repo', [conv('wt', T - 10, { cwd: '/w/repo-wt' })], '/w/repo-wt'),
          group('/w/repo', [conv('sub', T - 20, { cwd: '/w/repo/src' })], '/w/repo/src')
        ]
      })
    )
    expect(shape(model)).toEqual([
      { key: '/w/repo', collapsed: false, hidden: 1, blocks: [['un:/w/repo', 'wt', 'sub']] }
    ])
  })

  it('orders folders by their EARLIEST conversation, so activity in a folder never lifts it', () => {
    // By latest start, /w/old (T-5) would lead /w/new (T-50). By earliest, /w/new (T-50) leads
    // /w/old (T-100).
    const model = buildSidebar(
      input({
        groups: [group('/w/old', [conv('o1', T - 100), conv('o2', T - 5)]), group('/w/new', [conv('n1', T - 50)])]
      })
    )
    expect(keys(model)).toEqual(['/w/new', '/w/old'])
  })

  it('orders folders by a stored folder rank when one exists', () => {
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('a', T - 10)]), group('/w/b', [conv('b', T - 20)]), group('/w/c', [conv('c', T - 30)])],
        folderRanks: { '/w/c': T - 15 }
      })
    )
    expect(keys(model)).toEqual(['/w/a', '/w/c', '/w/b'])
  })

  it('shares one row rank space between the modes', () => {
    const groups = [group('/w/a', [conv('a1', T - 10), conv('a2', T - 40)]), group('/w/b', [conv('b1', T - 20)])]
    const rowRanks = { a2: T - 15 }
    const all = buildSidebar(input({ mode: 'all', groups, rowRanks, limits: { ...LIMITS, allCap: 9 } }))
    expect(visibleRows(all).map((r) => r.sessionId)).toEqual(['a1', 'a2', 'b1'])
    const folders = buildSidebar(input({ groups, rowRanks }))
    // The folders are ordered by their conversations' SEEDS (a2 started at T-40), not by a2's
    // dragged rank: a drag inside a folder never moves the folder.
    expect(shape(folders)).toEqual([
      { key: '/w/b', collapsed: false, hidden: 0, blocks: [['un:/w/b', 'b1']] },
      { key: '/w/a', collapsed: false, hidden: 0, blocks: [['un:/w/a', 'a1', 'a2']] }
    ])
  })

  it('keeps pins in their own folder, ahead of its unpinned rows, in pin order', () => {
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('a1', T - 10), conv('pa', T - 90)]), group('/w/b', [conv('pb', T - 5), conv('b1', T - 1)])],
        pinned: ['pb', 'pa']
      })
    )
    expect(shape(model)).toEqual([
      { key: '/w/b', collapsed: false, hidden: 0, blocks: [['pin:/w/b', 'pb'], ['un:/w/b', 'b1']] },
      { key: '/w/a', collapsed: false, hidden: 0, blocks: [['pin:/w/a', 'pa'], ['un:/w/a', 'a1']] }
    ])
  })
})

describe('live terminals', () => {
  it('places a terminal with no indexed conversation by its project root, at its start', () => {
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('a1', T - 10), conv('a2', T - 30)])],
        ptys: [pty('fresh', { cwd: '/w/a/sub', projectRoot: '/w/a', startedAt: T - 20 }), pty('elsewhere', { projectRoot: '/w/z', startedAt: T - 99 })],
        limits: { ...LIMITS, folderCap: 9 }
      })
    )
    expect(shape(model)).toEqual([
      { key: '/w/a', collapsed: false, hidden: 0, blocks: [['un:/w/a', 'a1', 'fresh', 'a2']] },
      { key: '/w/z', collapsed: false, hidden: 0, blocks: [['un:/w/z', 'elsewhere']] }
    ])
  })

  it('places an indexed conversation by its own folder and seed, not its terminal', () => {
    const model = buildSidebar(
      input({
        mode: 'all',
        groups: [group('/w/a', [conv('a1', T - 10), conv('resumed', T - 50)])],
        ptys: [pty('resumed', { projectRoot: '/w/other', startedAt: T })]
      })
    )
    expect(visibleRows(model).map((r) => [r.sessionId, r.rank])).toEqual([
      ['a1', T - 10],
      ['resumed', T - 50]
    ])
    const folders = buildSidebar(
      input({ groups: [group('/w/a', [conv('resumed', T - 50)])], ptys: [pty('resumed', { projectRoot: '/w/other' })] })
    )
    expect(keys(folders)).toEqual(['/w/a'])
  })
})

describe('hidden sessions', () => {
  it('drops hidden ids whether indexed, live or pinned', () => {
    const model = buildSidebar(
      input({
        mode: 'all',
        groups: [group('/w/a', [conv('keep', T - 1), conv('gone', T - 2), conv('pinnedGone', T - 3)])],
        ptys: [pty('liveGone')],
        pinned: ['pinnedGone'],
        hidden: new Set(['gone', 'liveGone', 'pinnedGone'])
      })
    )
    expect(visibleRows(model).map((r) => r.sessionId)).toEqual(['keep'])
  })

  it('returns a reappearing conversation to its seed or its override, never the top', () => {
    // A one-shot session hidden from the list and later resumed interactively comes back.
    const rows = [conv('new', T - 1), conv('mid', T - 50), conv('back', T - 100)]
    const without = buildSidebar(input({ mode: 'all', groups: [group('/w/a', rows.slice(0, 2))] }))
    expect(visibleRows(without).map((r) => r.sessionId)).toEqual(['new', 'mid'])
    const again = buildSidebar(input({ mode: 'all', groups: [group('/w/a', rows)] }))
    expect(visibleRows(again).map((r) => r.sessionId)).toEqual(['new', 'mid', 'back'])
    const dragged = buildSidebar(input({ mode: 'all', groups: [group('/w/a', rows)], rowRanks: { back: T - 25 } }))
    expect(visibleRows(dragged).map((r) => r.sessionId)).toEqual(['new', 'back', 'mid'])
  })
})

describe('collapse precedence', () => {
  // Three folders, newest first: /w/a, /w/b, /w/c. autoExpand is 2, so /w/c starts collapsed.
  const groups = [group('/w/a', [conv('a', T - 1)]), group('/w/b', [conv('b', T - 2)]), group('/w/c', [conv('c', T - 3)])]
  const collapsedOf = (over: Partial<SidebarInput>): boolean[] =>
    buildSidebar(input({ groups, ...over })).groups.map((g) => g.collapsed)

  it('collapses folders past the automatic count', () => {
    expect(collapsedOf({})).toEqual([false, false, true])
  })

  it('lets a stored preference beat the automatic rule both ways', () => {
    expect(collapsedOf({ collapsed: { '/w/a': true, '/w/c': false } })).toEqual([true, false, false])
  })

  it('lets a navigation expand beat a stored collapse', () => {
    expect(collapsedOf({ collapsed: { '/w/a': true }, navExpanded: new Set(['/w/a']) })).toEqual([false, false, true])
  })

  it('always expands the folder holding an active conversation, over a stored collapse', () => {
    expect(collapsedOf({ collapsed: { '/w/a': true }, active: new Set(['a']) })).toEqual([false, false, true])
    expect(collapsedOf({ active: new Set(['c']) })).toEqual([false, false, false])
  })

  it('expands everything while searching', () => {
    expect(collapsedOf({ collapsed: { '/w/a': true }, search: new Set(['a', 'b', 'c']) })).toEqual([false, false, false])
  })

  it('hides every row of a collapsed folder, its pins included', () => {
    const model = buildSidebar(
      input({ groups: [group('/w/a', [conv('pin', T - 5), conv('row', T - 1)])], pinned: ['pin'], collapsed: { '/w/a': true } })
    )
    expect(shape(model)).toEqual([{ key: '/w/a', collapsed: true, hidden: 0, blocks: [] }])
  })
})

describe('caps', () => {
  const five = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id, i) => conv(id, T - i))
  const rowsOf = (over: Partial<SidebarInput>): unknown[] => shape(buildSidebar(input({ groups: [group('/w/a', five)], ...over })))

  it('caps by position, so a live row never changes whether an idle row shows', () => {
    // r1 live at the top still takes a capped slot: r3 stays hidden whether r1 is live or not. A cap
    // counting only idle rows would let r3 in while r1 is live and drop it again when r1 stops.
    expect(rowsOf({ ptys: [pty('r1')] })).toEqual([
      { key: '/w/a', collapsed: false, hidden: 3, blocks: [['un:/w/a', 'r1', 'r2']] }
    ])
    expect(rowsOf({})).toEqual([{ key: '/w/a', collapsed: false, hidden: 3, blocks: [['un:/w/a', 'r1', 'r2']] }])
  })

  it('renders live and active rows past the cap, after the rest, in rank order', () => {
    expect(rowsOf({ ptys: [pty('r5')], active: new Set(['r4']) })).toEqual([
      { key: '/w/a', collapsed: false, hidden: 1, blocks: [['un:/w/a', 'r1', 'r2', 'r4', 'r5']] }
    ])
  })

  it('keeps r2 visible when a live row past the cap stops', () => {
    expect(rowsOf({ ptys: [pty('r4')] })).toEqual([
      { key: '/w/a', collapsed: false, hidden: 2, blocks: [['un:/w/a', 'r1', 'r2', 'r4']] }
    ])
    expect(rowsOf({})).toEqual([{ key: '/w/a', collapsed: false, hidden: 3, blocks: [['un:/w/a', 'r1', 'r2']] }])
  })

  it('reveals extra rows per folder', () => {
    expect(rowsOf({ revealed: { '/w/a': 2 } })).toEqual([
      { key: '/w/a', collapsed: false, hidden: 1, blocks: [['un:/w/a', 'r1', 'r2', 'r3', 'r4']] }
    ])
  })

  it('never caps pinned rows', () => {
    expect(rowsOf({ pinned: ['r3', 'r4', 'r5'] })).toEqual([
      { key: '/w/a', collapsed: false, hidden: 0, blocks: [['pin:/w/a', 'r3', 'r4', 'r5'], ['un:/w/a', 'r1', 'r2']] }
    ])
  })

  it('lifts every cap while searching and shows only matches', () => {
    expect(rowsOf({ search: new Set(['r1', 'r3', 'r4', 'r5']) })).toEqual([
      { key: '/w/a', collapsed: false, hidden: 0, blocks: [['un:/w/a', 'r1', 'r3', 'r4', 'r5']] }
    ])
  })

  it('drops a folder with no matching rows while searching', () => {
    const model = buildSidebar(
      input({ groups: [group('/w/a', [conv('a', T - 1)]), group('/w/b', [conv('b', T - 2)])], search: new Set(['b']) })
    )
    expect(keys(model)).toEqual(['/w/b'])
  })
})

describe('wantsAttention', () => {
  // The qualifying row r3 is the only one that could make it true, and sits behind two idle rows past
  // the cap of 2 — it renders only because it is live. The last case hides it outright, by collapse
  // and by search, and the flag must survive both.
  const rows = [conv('r1', T - 1), conv('r2', T - 2), conv('r3', T - 3)]
  const attention = (state: LiveState | null, over: Partial<SidebarInput> = {}): boolean =>
    buildSidebar(input({ groups: [group('/w/a', rows)], ptys: [pty('r3')], liveState: states({ r3: state }), ...over }))
      .groups[0].wantsAttention

  it('is true for asking and for awaiting, each alone', () => {
    expect(attention('asking')).toBe(true)
    expect(attention('awaiting')).toBe(true)
  })

  it('is false for working, quiet and unlinked, each alone', () => {
    expect(attention('working')).toBe(false)
    expect(attention('quiet')).toBe(false)
    expect(attention(null)).toBe(false)
  })

  it('counts rows the folder is not showing', () => {
    expect(attention('asking', { collapsed: { '/w/a': true } })).toBe(true)
    expect(attention('awaiting', { search: new Set(['r1']) })).toBe(true)
  })
})

describe('needsYou', () => {
  it('lists asking and awaiting sessions in fully expanded display order, through collapse, caps and search', () => {
    // /w/a leads and is collapsed; its pinned row comes before its unpinned one; /w/b's qualifying row
    // is past its cap. Working and quiet rows are left out.
    const ptys = ['a-pin', 'a-row', 'a-busy', 'b-late', 'b-quiet'].map((id) => pty(id))
    const liveState = states({ 'a-pin': 'awaiting', 'a-row': 'asking', 'a-busy': 'working', 'b-late': 'asking', 'b-quiet': 'quiet' })
    const groups = [
      group('/w/a', [conv('a-row', T - 1), conv('a-busy', T - 2), conv('a-pin', T - 50)]),
      group('/w/b', [conv('b1', T - 60), conv('b2', T - 61), conv('b-quiet', T - 62), conv('b-late', T - 63)])
    ]
    const base = { groups, ptys, liveState, pinned: ['a-pin'], collapsed: { '/w/a': true } }
    expect(buildSidebar(input(base)).needsYou).toEqual(['a-pin', 'a-row', 'b-late'])
    expect(buildSidebar(input({ ...base, search: new Set(['b1']) })).needsYou).toEqual(['a-pin', 'a-row', 'b-late'])
    expect(buildSidebar(input({ ...base, mode: 'all' })).needsYou).toEqual(['a-pin', 'a-row', 'b-late'])
  })
})

describe('labels', () => {
  it('uses the basename, widened only where two projects collide', () => {
    const labels = folderLabels(['/w/one/app', '/w/two/app', '/w/solo', '/x/y/one/app'])
    expect(Object.fromEntries(labels)).toEqual({
      '/w/one/app': 'w/one/app',
      '/w/two/app': 'two/app',
      '/w/solo': 'solo',
      '/x/y/one/app': 'y/one/app'
    })
  })

  it('drops a bare repository suffix', () => {
    expect(folderLabels(['/w/proj.git']).get('/w/proj.git')).toBe('proj')
  })

  it('labels the group in the model', () => {
    const model = buildSidebar(input({ groups: [group('/w/one/app', [conv('a', T)]), group('/w/two/app', [conv('b', T - 1)])] }))
    expect(model.groups.map((g) => g.label)).toEqual(['one/app', 'two/app'])
  })
})

describe('an empty or loading catalog', () => {
  it('builds an empty model and touches none of its inputs', () => {
    const rowRanks = Object.freeze({ a: T })
    const folderRanks = Object.freeze({ '/w/a': T })
    const collapsed = Object.freeze({ '/w/a': true })
    const pinned = Object.freeze(['a'])
    const model = buildSidebar(input({ rowRanks, folderRanks, collapsed, pinned }))
    expect(model).toEqual({ groups: [], needsYou: [] })
    expect([rowRanks, folderRanks, collapsed, pinned]).toEqual([{ a: T }, { '/w/a': T }, { '/w/a': true }, ['a']])
  })
})
