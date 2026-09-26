import { describe, expect, it } from 'vitest'
import type { ConversationGroup, ConversationMeta, LiveState, PtyState } from '../src/shared/types'
import { absorbBind, absorbBindFolder } from '../src/renderer/lib/rowRank'
import {
  buildSidebar,
  conversationSeed,
  folderLabels,
  needsYou,
  freezeFoldersByNewest,
  folderRankSpace,
  rankSpace,
  resumeWrites,
  visibleRows,
  enteredFolders,
  withFolders,
  withoutFolders,
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
  return { cwd, root, worktree: cwd !== root, exists: true, rootExists: true, label: cwd, conversations, latestMtime: 0 }
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
    activeCollapsed: new Set(),
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

  it('prefer the first message to the file birthtime when both exist', () => {
    // A row whose birthtime is older than its first message, beside a row that started in between:
    // reading birthtime first would put the two in the wrong order.
    const model = buildSidebar(
      input({
        mode: 'all',
        groups: [group('/w/repo', [conv('a', T, { birthtimeMs: T - 1000 }), conv('between', T - 500)])]
      })
    )
    expect(visibleRows(model).map((r) => r.sessionId)).toEqual(['a', 'between'])
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

  it('lets a folder the user collapsed while active stay collapsed', () => {
    expect(
      collapsedOf({ collapsed: { '/w/a': true }, active: new Set(['a']), activeCollapsed: new Set(['/w/a']) })
    ).toEqual([true, false, true])
    // Only the active rule is lifted: with nothing active there, the entry changes nothing.
    expect(collapsedOf({ activeCollapsed: new Set(['/w/a', '/w/c']), collapsed: { '/w/c': false } })).toEqual([
      false,
      false,
      false
    ])
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
    // A folder rank moving /w/b first must reorder Folders mode's list and leave All mode's alone — a
    // list sorted globally regardless of mode passes every assertion above.
    const bFirst = { ...base, folderRanks: { '/w/b': T } }
    expect(buildSidebar(input(bFirst)).needsYou).toEqual(['b-late', 'a-pin', 'a-row'])
    expect(buildSidebar(input({ ...bFirst, mode: 'all' })).needsYou).toEqual(['a-pin', 'a-row', 'b-late'])
  })
})

describe('needsYou', () => {
  it('is asking or unread, and nothing else — the tag, a bold folder and a bold row all read it', () => {
    expect(needsYou('asking')).toBe(true)
    expect(needsYou('awaiting')).toBe(true)
    expect(needsYou('working')).toBe(false)
    expect(needsYou('quiet')).toBe(false)
    expect(needsYou(null)).toBe(false)
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

  it('labels every folder in All mode too, where no header shows one — including a terminal-only root', () => {
    // Colliding basenames, so a map of bare basenames fails; a root that only a live terminal names,
    // so a map built from the indexed groups alone misses it.
    const model = buildSidebar(
      input({
        mode: 'all',
        groups: [group('/w/one/app', [conv('a', T)]), group('/w/two/app', [conv('b', T - 1)])],
        ptys: [pty('t', { projectRoot: '/w/fresh', cwd: '/w/fresh' })]
      })
    )
    expect(Object.fromEntries(model.labels)).toEqual({
      '/w/one/app': 'one/app',
      '/w/two/app': 'two/app',
      '/w/fresh': 'fresh'
    })
    // The one All-mode group stays unlabeled.
    expect(model.groups.map((g) => g.label)).toEqual([''])
  })
})

describe('an empty or loading catalog', () => {
  it('builds an empty model and touches none of its inputs', () => {
    const rowRanks = Object.freeze({ a: T })
    const folderRanks = Object.freeze({ '/w/a': T })
    const collapsed = Object.freeze({ '/w/a': true })
    const pinned = Object.freeze(['a'])
    const model = buildSidebar(input({ rowRanks, folderRanks, collapsed, pinned }))
    expect(model).toEqual({ groups: [], rows: new Map(), folders: new Map(), labels: new Map(), needsYou: [] })
    expect([rowRanks, folderRanks, collapsed, pinned]).toEqual([{ a: T }, { '/w/a': T }, { '/w/a': true }, ['a']])
  })
})

describe('All mode is always one group', () => {
  it('keeps its single group with an empty catalog and with a search matching nothing', () => {
    const empty = { key: '', collapsed: false, hidden: 0, blocks: [] }
    expect(shape(buildSidebar(input({ mode: 'all' })))).toEqual([empty])
    expect(
      shape(buildSidebar(input({ mode: 'all', groups: [group('/w/a', [conv('a', T)])], search: new Set(['none']) })))
    ).toEqual([empty])
  })
})

describe('an initial bind', () => {
  // Folder /w/a's only row is a Codex placeholder started at T; /w/b's conversation started at T+1000,
  // so /w/b leads. The placeholder binds to a conversation whose first message is at T+3000.
  const before = buildSidebar(
    input({
      groups: [group('/w/b', [conv('b', T + 1000)])],
      ptys: [pty('ph', { agent: 'codex', projectRoot: '/w/a', startedAt: T, provisional: true })]
    })
  )
  const after = (rowRanks: Record<string, number>, folderRanks: Record<string, number>): SidebarModel =>
    buildSidebar(
      input({
        groups: [group('/w/b', [conv('b', T + 1000)]), group('/w/a', [conv('real', T + 3000, { agent: 'codex' })])],
        ptys: [pty('real', { agent: 'codex', projectRoot: '/w/a', startedAt: T })],
        rowRanks,
        folderRanks
      })
    )

  it('keeps both the row and its brand-new folder where they were', () => {
    expect(keys(before)).toEqual(['/w/b', '/w/a'])
    // What App reads off the last rendered model when the bind lands.
    const place = before.rows.get('ph')!
    expect(place).toEqual({ rank: T, seed: T, root: '/w/a', pinned: false })
    const rowRanks = absorbBind({}, place.rank, 'ph', 'real')
    const folderRanks = absorbBindFolder({}, place.root, before.folders.get(place.root)!, place.seed)
    expect(folderRanks).toEqual({ '/w/a': T })
    expect(keys(after(rowRanks, folderRanks))).toEqual(['/w/b', '/w/a'])
    // Without the folder write the folder's seed rises to T+3000 and it jumps above /w/b.
    expect(keys(after(rowRanks, {}))).toEqual(['/w/a', '/w/b'])
  })

  it('writes no folder rank when an older row holds the seed or the folder is already placed', () => {
    expect(absorbBindFolder({}, '/w/a', { rank: T - 50, seed: T - 50 }, T)).toEqual({})
    const placed = { '/w/a': T - 7 }
    expect(absorbBindFolder(placed, '/w/a', { rank: T - 7, seed: T }, T)).toBe(placed)
  })
})

describe('row places', () => {
  // A search matching only c1 leaves every other row off screen, and /w/c's rows exceed the folder
  // cap; the index holds them all anyway. (Collapse is covered by the Resume case below.)
  const model = buildSidebar(
    input({
      groups: [
        group('/w/c', [conv('c1', T - 1), conv('c2', T - 2), conv('c3', T - 3)]),
        group('/w/b', [conv('b1', T - 10), conv('pin', T - 11)]),
        group('/w/a', [conv('a1', T - 20, { cwd: '/w/a/src' })], '/w/a/src'),
        group('/w/h', [conv('hid', T - 30)])
      ],
      ptys: [pty('fresh', { projectRoot: '/w/new', startedAt: T + 7 })],
      pinned: ['pin'],
      hidden: new Set(['hid']),
      rowRanks: { c3: T + 50 },
      search: new Set(['c1'])
    })
  )

  it('holds every row that is not hidden, through search and caps', () => {
    expect(Object.fromEntries(model.rows)).toEqual({
      c1: { rank: T - 1, seed: T - 1, root: '/w/c', pinned: false },
      c2: { rank: T - 2, seed: T - 2, root: '/w/c', pinned: false },
      c3: { rank: T + 50, seed: T - 3, root: '/w/c', pinned: false },
      b1: { rank: T - 10, seed: T - 10, root: '/w/b', pinned: false },
      pin: { rank: -0, seed: T - 11, root: '/w/b', pinned: true },
      a1: { rank: T - 20, seed: T - 20, root: '/w/a', pinned: false },
      fresh: { rank: T + 7, seed: T + 7, root: '/w/new', pinned: false }
    })
  })

  it('gives drops and Resumes the unpinned rows as their rank space', () => {
    expect(rankSpace(model).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'a1', rank: T - 20 },
      { id: 'b1', rank: T - 10 },
      { id: 'c1', rank: T - 1 },
      { id: 'c2', rank: T - 2 },
      { id: 'c3', rank: T + 50 },
      { id: 'fresh', rank: T + 7 }
    ])
  })
})

describe('the folder rank space', () => {
  it('holds every folder at its override, else its earliest row, whatever search shows', () => {
    const model = buildSidebar(
      input({
        groups: [
          group('/w/c', [conv('c1', T - 1), conv('c2', T - 9)]),
          group('/w/b', [conv('b1', T - 10)]),
          group('/w/a', [conv('a1', T - 20)])
        ],
        folderRanks: { '/w/a': T + 5 },
        search: new Set(['b1'])
      })
    )
    expect(folderRankSpace(model).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: '/w/a', rank: T + 5 },
      { id: '/w/b', rank: T - 10 },
      { id: '/w/c', rank: T - 9 }
    ])
  })
})

describe('a Resume', () => {
  // `ahead` was dragged to the top of a folder the automatic rule collapses, so its rank is past the
  // clock and it is not on screen. A Resume must still land above it.
  const model = buildSidebar(
    input({
      groups: [
        group('/w/one', [conv('old', T - 5000), conv('pin', T - 100)]),
        group('/w/two', [conv('mid', T - 3000)]),
        group('/w/three', [conv('ahead', T - 4000)])
      ],
      pinned: ['pin'],
      rowRanks: { ahead: T + 500 },
      folderRanks: { '/w/three': T - 9000 }
    })
  )

  it('lifts the row above every unpinned row, shown or not', () => {
    expect(model.groups.find((g) => g.key === '/w/three')?.collapsed).toBe(true)
    expect(resumeWrites(model, 'old', T)).toEqual({ old: T + 501 })
  })

  it('writes nothing for a pinned row, or a row the model does not hold', () => {
    expect(resumeWrites(model, 'pin', T)).toEqual({})
    expect(resumeWrites(model, 'nobody', T)).toEqual({})
  })
})

describe('entering folders', () => {
  it('enters the folder of every conversation that became active', () => {
    expect(enteredFolders([['a1', '/w/a']], [['a1', '/w/a'], ['b1', '/w/b']])).toEqual(['/w/b'])
  })

  it('does not enter a folder that merely stays active, when the OTHER pane moves', () => {
    // Split view on A and B; the other pane moves B -> C. A was collapsed by hand and must stay so.
    expect(enteredFolders([['a1', '/w/a'], ['b1', '/w/b']], [['a1', '/w/a'], ['c1', '/w/c']])).toEqual(['/w/c'])
  })

  it('enters a folder again when another conversation in it becomes active', () => {
    // The needs-you tag opening a row in the folder the user collapsed while it was active.
    expect(enteredFolders([['a1', '/w/a']], [['a2', '/w/a']])).toEqual(['/w/a'])
  })

  it('lists each folder once', () => {
    expect(enteredFolders([], [['a1', '/w/a'], ['a2', '/w/a']])).toEqual(['/w/a'])
  })
})

describe('folder sets', () => {
  it('adds and removes, returning the same set when nothing changes', () => {
    const set = new Set(['/w/a'])
    expect([...withFolders(set, ['/w/a', '/w/b'])]).toEqual(['/w/a', '/w/b'])
    expect(withFolders(set, ['/w/a'])).toBe(set)
    expect([...withoutFolders(new Set(['/w/a', '/w/b']), ['/w/a', '/w/z'])]).toEqual(['/w/b'])
    expect(withoutFolders(set, ['/w/z'])).toBe(set)
    expect([...set]).toEqual(['/w/a'])
  })
})

describe('the one-time folder freeze', () => {
  // /w/a started long ago but has the newest conversation; /w/b has one conversation in between. By
  // earliest start (the ordinary seed) /w/b leads; frozen by newest, /w/a leads.
  const base = input({
    groups: [
      group('/w/a', [conv('a-old', T - 100), conv('a-new', T - 5)]),
      group('/w/b', [conv('b1', T - 50), conv('b-hidden', T + 900)]),
      group('/w/c', [conv('c1', T - 1)])
    ],
    hidden: new Set(['b-hidden']),
    // b1 was resumed, so its rank is past every start; folders freeze by when rows STARTED.
    rowRanks: { b1: T + 100 }
  })

  it('ranks every folder by its newest visible row, and keeps a folder already placed', () => {
    const model = buildSidebar(base)
    expect(keys(model)).toEqual(['/w/c', '/w/b', '/w/a'])
    const frozen = freezeFoldersByNewest(model, { '/w/c': T - 999 })
    expect(frozen).toEqual({ '/w/a': T - 5, '/w/b': T - 50, '/w/c': T - 999 })
    expect(keys(buildSidebar({ ...base, folderRanks: frozen }))).toEqual(['/w/a', '/w/b', '/w/c'])
  })

  it('stays put when a conversation later starts in a folder', () => {
    const frozen = freezeFoldersByNewest(buildSidebar(base), {})
    const later = buildSidebar({
      ...base,
      groups: [...base.groups, group('/w/b', [conv('b-late', T + 5000)])],
      folderRanks: frozen
    })
    // Frozen newest-first (c at T-1, a at T-5, b at T-50); /w/b's new conversation does not lift it.
    expect(keys(later)).toEqual(['/w/c', '/w/a', '/w/b'])
  })
})
