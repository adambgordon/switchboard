import { describe, expect, it } from 'vitest'
import type { ConversationGroup, ConversationMeta, LiveState, PtyState } from '../src/shared/types'
import {
  absorbBind,
  absorbBindFolder,
  dropWrites,
  holdRank,
  liftWrites,
  spreadWrites,
  type RankOverrides
} from '../src/renderer/lib/rowRank'
import {
  buildSidebar,
  conversationSeed,
  folderLabels,
  needsYou,
  freezeFoldersByNewest,
  folderRankSpace,
  rankSpace,
  buildSidebarHeld,
  dropNeighbors,
  dropNeighborsMany,
  liftLiveWrites,
  liveFirstToggleWrites,
  resumeWrites,
  sinkStopped,
  stopFold,
  stoppedRows,
  unpinRanks,
  unpinWrites,
  visibleRows,
  enteredFolders,
  withFolders,
  withoutFolders,
  type SidebarInput,
  type SidebarModel
} from '../src/renderer/lib/sidebarModel'
import { NO_FILTER, NOTHING_HIDDEN } from '../src/renderer/lib/railFilter'
import type { SidebarMode } from '../src/renderer/lib/sidebarPrefs'

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
    usedByUser: false,
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
const LIMITS = { folderCap: 2, allCap: 3, minUnpinned: 1, autoExpand: 2 }

function input(over: Partial<SidebarInput> = {}): SidebarInput {
  return {
    mode: 'folders',
    groups: [],
    ptys: [],
    pinned: [],
    delegated: new Set(),
    userHidden: NOTHING_HIDDEN,
    filter: NO_FILTER,
    rowRanks: {},
    folderRanks: {},
    liveState: states({}),
    active: new Set(),
    collapsed: {},
    autoCollapsed: null,
    navExpanded: new Set(),
    activeCollapsed: new Set(),
    revealed: {},
    search: null,
    limits: LIMITS,
    ...over
  }
}

/** The whole rendered shape: each group's key, collapse, withheld count and blocks' row ids. */
function shape(model: SidebarModel): unknown[] {
  return model.groups.map((g) => ({
    key: g.key,
    collapsed: g.collapsed,
    withheld: g.withheld,
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
    // Why `?? mtime` is not harmless: every write would lift the row.
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
        pinned: ['p2', 'p1'],
        // Five rows, the two pins among them: three unpinned show, and the fourth is past the cap.
        limits: { ...LIMITS, allCap: 5 }
      })
    )
    expect(model.groups.map((g) => [g.key, g.header, g.label])).toEqual([['', false, '']])
    expect(shape(model)).toEqual([
      { key: '', collapsed: false, withheld: 1, blocks: [['pin:*', 'p2', 'p1'], ['un:*', 'a', 'c', 'd']] }
    ])
  })

  it('never collapses, whatever is stored', () => {
    const model = buildSidebar(
      input({ mode: 'all', groups: [group('/w/one', [conv('a', T)])], collapsed: { '': true, '/w/one': true } })
    )
    expect(shape(model)).toEqual([{ key: '', collapsed: false, withheld: 0, blocks: [['un:*', 'a']] }])
  })

  it('uses the All cap, not the folder cap', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id, i) => conv(id, T - i))
    const model = buildSidebar(input({ mode: 'all', groups: [group('/w/one', rows)] }))
    expect(shape(model)).toEqual([{ key: '', collapsed: false, withheld: 2, blocks: [['un:*', 'a', 'b', 'c']] }])
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
      { key: '/w/repo', collapsed: false, withheld: 1, blocks: [['un:/w/repo', 'wt', 'sub']] }
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
      { key: '/w/b', collapsed: false, withheld: 0, blocks: [['un:/w/b', 'b1']] },
      { key: '/w/a', collapsed: false, withheld: 0, blocks: [['un:/w/a', 'a1', 'a2']] }
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
      { key: '/w/b', collapsed: false, withheld: 0, blocks: [['pin:/w/b', 'pb'], ['un:/w/b', 'b1']] },
      { key: '/w/a', collapsed: false, withheld: 0, blocks: [['pin:/w/a', 'pa'], ['un:/w/a', 'a1']] }
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
      { key: '/w/a', collapsed: false, withheld: 0, blocks: [['un:/w/a', 'a1', 'fresh', 'a2']] },
      { key: '/w/z', collapsed: false, withheld: 0, blocks: [['un:/w/z', 'elsewhere']] }
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

describe('delegated sessions', () => {
  it('drops delegated ids whether indexed, live or pinned', () => {
    const model = buildSidebar(
      input({
        mode: 'all',
        groups: [group('/w/a', [conv('keep', T - 1), conv('gone', T - 2), conv('pinnedGone', T - 3)])],
        ptys: [pty('liveGone')],
        pinned: ['pinnedGone'],
        delegated: new Set(['gone', 'liveGone', 'pinnedGone'])
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
    expect(buildSidebar(input({ groups })).autoCollapsed).toEqual(new Set(['/w/c']))
  })

  it('keeps the folders fixed at launch, however the order changes after', () => {
    const launch = buildSidebar(input({ groups })).autoCollapsed
    // A folder arriving at the top pushes /w/b past the automatic count; it stays open, and so does the
    // newcomer, while /w/c stays collapsed.
    const arrived = [group('/w/new', [conv('n', T)]), ...groups]
    expect(collapsedOf({ groups: arrived, autoCollapsed: launch })).toEqual([false, false, false, true])
    // A folder dragged below the count stays open; the one it passes stays collapsed.
    expect(collapsedOf({ folderRanks: { '/w/a': T - 10 }, autoCollapsed: launch })).toEqual([false, true, false])
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
    expect(shape(model)).toEqual([{ key: '/w/a', collapsed: true, withheld: 0, blocks: [] }])
  })
})

describe('caps', () => {
  const five = ['r1', 'r2', 'r3', 'r4', 'r5'].map((id, i) => conv(id, T - i))
  const rowsOf = (over: Partial<SidebarInput>): unknown[] => shape(buildSidebar(input({ groups: [group('/w/a', five)], ...over })))

  it('caps by position, so a live row never changes whether an idle row shows', () => {
    // r1 live at the top still takes a capped slot: r3 stays hidden whether r1 is live or not. A cap
    // counting only idle rows would let r3 in while r1 is live and drop it again when r1 stops.
    expect(rowsOf({ ptys: [pty('r1')] })).toEqual([
      { key: '/w/a', collapsed: false, withheld: 3, blocks: [['un:/w/a', 'r1', 'r2']] }
    ])
    expect(rowsOf({})).toEqual([{ key: '/w/a', collapsed: false, withheld: 3, blocks: [['un:/w/a', 'r1', 'r2']] }])
  })

  it('renders live and active rows past the cap, after the rest, in rank order', () => {
    expect(rowsOf({ ptys: [pty('r5')], active: new Set(['r4']) })).toEqual([
      { key: '/w/a', collapsed: false, withheld: 1, blocks: [['un:/w/a', 'r1', 'r2', 'r4', 'r5']] }
    ])
  })

  it('keeps r2 visible when a live row past the cap stops', () => {
    expect(rowsOf({ ptys: [pty('r4')] })).toEqual([
      { key: '/w/a', collapsed: false, withheld: 2, blocks: [['un:/w/a', 'r1', 'r2', 'r4']] }
    ])
    expect(rowsOf({})).toEqual([{ key: '/w/a', collapsed: false, withheld: 3, blocks: [['un:/w/a', 'r1', 'r2']] }])
  })

  it('reveals extra rows per folder', () => {
    expect(rowsOf({ revealed: { '/w/a': 2 } })).toEqual([
      { key: '/w/a', collapsed: false, withheld: 1, blocks: [['un:/w/a', 'r1', 'r2', 'r3', 'r4']] }
    ])
  })

  it('never caps pinned rows, and keeps the unpinned floor past a full cap of pins', () => {
    // Three pins against a cap of 2: every pin shows, and the floor of 2 still leaves both unpinned
    // rows. A floor of 2, not the default 1: cap − pins is −1 here, and slicing to −1 happens to leave
    // one row, so with a floor of 1 a missing floor would pass.
    expect(rowsOf({ pinned: ['r3', 'r4', 'r5'], limits: { ...LIMITS, minUnpinned: 2 } })).toEqual([
      { key: '/w/a', collapsed: false, withheld: 0, blocks: [['pin:/w/a', 'r3', 'r4', 'r5'], ['un:/w/a', 'r1', 'r2']] }
    ])
  })

  it('counts pinned rows toward the cap', () => {
    // One pin and a cap of 2 leave room for one unpinned row, not two.
    expect(rowsOf({ pinned: ['r5'] })).toEqual([
      { key: '/w/a', collapsed: false, withheld: 3, blocks: [['pin:/w/a', 'r5'], ['un:/w/a', 'r1']] }
    ])
  })

  it('lifts every cap while searching and shows only matches', () => {
    expect(rowsOf({ search: new Set(['r1', 'r3', 'r4', 'r5']) })).toEqual([
      { key: '/w/a', collapsed: false, withheld: 0, blocks: [['un:/w/a', 'r1', 'r3', 'r4', 'r5']] }
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
    expect(model).toEqual({ groups: [], rows: new Map(), folders: new Map(), labels: new Map(), needsYou: [], filteredOut: 0, autoCollapsed: new Set() })
    expect([rowRanks, folderRanks, collapsed, pinned]).toEqual([{ a: T }, { '/w/a': T }, { '/w/a': true }, ['a']])
  })
})

describe('All mode is always one group', () => {
  it('keeps its single group with an empty catalog and with a search matching nothing', () => {
    const empty = { key: '', collapsed: false, withheld: 0, blocks: [] }
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
    expect(place).toEqual({ rank: T, seed: T, root: '/w/a', pinned: false, live: true })
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

describe("a new Claude conversation's first index", () => {
  // Two new terminals in a brand-new folder /w/n: 'a' started at T, 'b' at T+1000, neither indexed, so
  // 'b' leads. /w/o's conversation started at T+500, so /w/o leads /w/n. Then 'a' gets its first
  // message, at T+3000, and the index lists it.
  const ptys = [pty('a', { projectRoot: '/w/n', startedAt: T, origin: 'new' }), pty('b', { projectRoot: '/w/n', startedAt: T + 1000, origin: 'new' })]
  const before = buildSidebar(input({ groups: [group('/w/o', [conv('o', T + 500)])], ptys }))
  const indexed = (over: Partial<SidebarInput> = {}): SidebarInput =>
    input({ groups: [group('/w/o', [conv('o', T + 500)]), group('/w/n', [conv('a', T + 3000)])], ptys, ...over })
  const rowsOf = (model: SidebarModel, key: string): string[] =>
    model.groups.find((g) => g.key === key)!.blocks.flatMap((b) => b.rows.map((r) => r.sessionId))

  it('keeps the row and its folder where they were, in the same build', () => {
    expect(rowsOf(before, '/w/n')).toEqual(['b', 'a'])
    const held = buildSidebarHeld(before, indexed())
    expect(held.rowRanks).toEqual({ a: T })
    expect(held.folderRanks).toEqual({ '/w/n': T })
    expect(keys(held.model)).toEqual(['/w/o', '/w/n'])
    expect(rowsOf(held.model, '/w/n')).toEqual(['b', 'a'])
    // Unheld, 'a' jumps above 'b', and /w/n above /w/o.
    const unheld = buildSidebar(indexed())
    expect(rowsOf(unheld, '/w/n')).toEqual(['a', 'b'])
    expect(keys(unheld)).toEqual(['/w/n', '/w/o'])
  })

  it('holds nothing without a model to hold against, or once the hold is stored', () => {
    const plain = indexed()
    expect(buildSidebarHeld(null, plain).rowRanks).toBe(plain.rowRanks)
    const stored = indexed({ rowRanks: { a: T }, folderRanks: { '/w/n': T } })
    const again = buildSidebarHeld(buildSidebarHeld(before, indexed()).model, stored)
    expect(again.rowRanks).toBe(stored.rowRanks)
    expect(again.folderRanks).toBe(stored.folderRanks)
  })

  it('leaves a row the user already placed', () => {
    const placed = { a: T + 9 }
    expect(holdRank(placed, 'a', T)).toBe(placed)
    expect(buildSidebarHeld(before, indexed({ rowRanks: placed })).rowRanks).toBe(placed)
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
      delegated: new Set(['hid']),
      rowRanks: { c3: T + 50 },
      search: new Set(['c1'])
    })
  )

  it('holds every row that is not delegated, through search and caps', () => {
    expect(Object.fromEntries(model.rows)).toEqual({
      c1: { rank: T - 1, seed: T - 1, root: '/w/c', pinned: false, live: false },
      c2: { rank: T - 2, seed: T - 2, root: '/w/c', pinned: false, live: false },
      c3: { rank: T + 50, seed: T - 3, root: '/w/c', pinned: false, live: false },
      b1: { rank: T - 10, seed: T - 10, root: '/w/b', pinned: false, live: false },
      pin: { rank: -0, seed: T - 11, root: '/w/b', pinned: true, live: false },
      a1: { rank: T - 20, seed: T - 20, root: '/w/a', pinned: false, live: false },
      fresh: { rank: T + 7, seed: T + 7, root: '/w/new', pinned: false, live: true }
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

describe('a drop beside a row shown past the cap', () => {
  // c0 newest … c5 oldest; c5 is live, so with a cap of 2 the folder shows c0, c1, then c5 — and c2–c4
  // are withheld between c1 and c5.
  const convs = [0, 1, 2, 3, 4, 5].map((i) => conv(`c${i}`, T - i * 1000))
  const build = (rowRanks: Record<string, number> = {}): SidebarModel =>
    buildSidebar(input({ groups: [group('/w/r', convs)], ptys: [pty('c5')], rowRanks }))
  const shownRows = (model: SidebarModel): string[] => model.groups[0].blocks[0].rows.map((r) => r.sessionId)
  const drop = (higher: string | null, lower: string | null): string[] => {
    const model = build()
    const block = model.groups[0].blocks[0]
    const [h, l] = dropNeighbors(model, block, 'c0', higher, lower)
    return shownRows(build(dropWrites(rankSpace(model), 'c0', h, l, T)))
  }

  it('keeps the dropped row on screen, directly below the row it was dropped under', () => {
    expect(shownRows(build())).toEqual(['c0', 'c1', 'c5'])
    expect(drop('c1', 'c5')).toEqual(['c1', 'c0', 'c5'])
    // Taken as shown, the neighbors straddle c2–c4, and the midpoint withholds c0 among them.
    const model = build()
    expect(shownRows(build(dropWrites(rankSpace(model), 'c0', 'c1', 'c5', T)))).toEqual(['c1', 'c2', 'c5'])
  })

  it('lands below the last row shown in order when dropped under the row past the cap', () => {
    expect(drop('c5', null)).toEqual(['c1', 'c0', 'c5'])
  })

  it('keeps a capped row on screen dropped under a live row that sits right at the cap', () => {
    // Nothing withheld between the cap and the live row, so the rows match their full order all the
    // way down — only the cap says where the shown-in-order run ends.
    const four = [0, 1, 2, 3].map((i) => conv(`c${i}`, T - i * 1000))
    const at = (rowRanks: Record<string, number> = {}): SidebarModel =>
      buildSidebar(input({ groups: [group('/w/r', four)], ptys: [pty('c2')], rowRanks }))
    const model = at()
    const block = model.groups[0].blocks[0]
    expect(block.rows.map((r) => r.sessionId)).toEqual(['c0', 'c1', 'c2'])
    const [h, l] = dropNeighbors(model, block, 'c0', 'c2', null)
    expect(shownRows(at(dropWrites(rankSpace(model), 'c0', h, l, T)))).toEqual(['c1', 'c0', 'c2'])
  })

  it('takes a drop of a row past the cap as it is: it shows wherever it lands', () => {
    const twoLive = (rowRanks: Record<string, number> = {}): SidebarModel =>
      buildSidebar(input({ groups: [group('/w/r', convs)], ptys: [pty('c4'), pty('c5')], rowRanks }))
    const model = twoLive()
    const block = model.groups[0].blocks[0]
    expect(block.rows.map((r) => r.sessionId)).toEqual(['c0', 'c1', 'c4', 'c5'])
    expect(dropNeighbors(model, block, 'c4', 'c5', null)).toEqual(['c5', null])
    expect(shownRows(twoLive(dropWrites(rankSpace(model), 'c4', 'c5', null, T)))).toEqual(['c0', 'c1', 'c5', 'c4'])
  })

  it('leaves a drop between rows adjacent in order, or at the top, as it was', () => {
    const model = build()
    const block = model.groups[0].blocks[0]
    expect(dropNeighbors(model, block, 'c1', null, 'c0')).toEqual([null, 'c0'])
    expect(dropNeighbors(model, block, 'c5', 'c0', 'c1')).toEqual(['c0', 'c1'])
  })

  it('leaves the last capped row where it is when dropped below a row past the cap', () => {
    // A cap of 4 shows c0–c3, then live c6 and on-screen c7 past it. c3 sits just above c4, with
    // another folder's n0 between c2 and it: landing below c2, the capped row above it, would lift c3
    // over n0 in All mode for a drag that moved it down.
    const eight = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => conv(`c${i}`, T - i * 1000))
    const model = buildSidebar(
      input({
        groups: [group('/w/r', eight), group('/w/n', [conv('n0', T - 3500)])],
        ptys: [pty('c6')],
        active: new Set(['c7']),
        rowRanks: { c3: T - 3900 },
        limits: { ...LIMITS, folderCap: 4 }
      })
    )
    const block = model.groups.find((g) => g.key === '/w/r')!.blocks[0]
    expect(block.rows.map((r) => r.sessionId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c6', 'c7'])
    expect(block.capped).toBe(4)
    expect(dropNeighbors(model, block, 'c3', 'c7', null)).toEqual([null, null])
    expect(dropNeighborsMany(model, block, ['c3'], 'c7', null)).toEqual([null, null])
    expect(dropWrites(rankSpace(model), 'c3', null, null, T)).toEqual({})
    // The fixture's point: the landing below c2 outranks n0, which c3 does not.
    const rank = (id: string): number => model.rows.get(id)!.rank
    expect(dropWrites(rankSpace(model), 'c3', 'c2', 'c4', T).c3).toBeGreaterThan(rank('n0'))
    expect(rank('c3')).toBeLessThan(rank('n0'))
    // Only the clamp is caught: a move among the capped rows, or of a row above the last, still lands,
    // and so does a group, which staying put would leave scattered.
    expect(dropNeighbors(model, block, 'c3', 'c0', 'c1')).toEqual(['c0', 'c1'])
    expect(dropNeighbors(model, block, 'c1', 'c7', null)).toEqual(['c3', 'c4'])
    expect(dropNeighborsMany(model, block, ['c3', 'c6'], 'c7', null)).toEqual(['c2', 'c4'])
  })

  it('leaves a block’s only capped row where it is when dropped below a row past the cap', () => {
    // One pin and a cap of 2 leave one unpinned row in order, c0, then live c4 past it. With no capped
    // row above c0 to land under, the landing would be the folder's top, which a later clock lifts over
    // another folder's newer n0 in All mode, for a drag that moved c0 down.
    const five = [0, 1, 2, 3, 4].map((i) => conv(`c${i}`, T - i * 1000))
    const model = buildSidebar(
      input({
        groups: [group('/w/r', [conv('p0', T - 5000), ...five]), group('/w/n', [conv('n0', T + 500)])],
        pinned: ['p0'],
        ptys: [pty('c4')]
      })
    )
    const block = model.groups.find((g) => g.key === '/w/r')!.blocks.find((b) => b.kind === 'unpinned')!
    expect(block.rows.map((r) => r.sessionId)).toEqual(['c0', 'c4'])
    expect(block.capped).toBe(1)
    expect(dropNeighbors(model, block, 'c0', 'c4', null)).toEqual([null, null])
    // The fixture's point: the folder's top, written at a later clock, outranks n0, which c0 does not.
    const rank = (id: string): number => model.rows.get(id)!.rank
    expect(dropWrites(rankSpace(model), 'c0', null, 'c1', T + 10000).c0).toBeGreaterThan(rank('n0'))
    expect(rank('c0')).toBeLessThan(rank('n0'))
  })
})

describe('a group dropped beside a row shown past the cap', () => {
  // As above: c0 newest … c5 oldest, a cap of 2, so the folder shows c0, c1 and then the live c5.
  const convs = [0, 1, 2, 3, 4, 5].map((i) => conv(`c${i}`, T - i * 1000))
  const build = (live: string[], rowRanks: Record<string, number> = {}): SidebarModel =>
    buildSidebar(input({ groups: [group('/w/r', convs)], ptys: live.map((id) => pty(id)), rowRanks }))
  const shownRows = (model: SidebarModel): string[] => model.groups[0].blocks[0].rows.map((r) => r.sessionId)

  it('carrying every capped row, lands at the top rather than out of sight under the live row', () => {
    const model = build(['c5'])
    const block = model.groups[0].blocks[0]
    expect(shownRows(model)).toEqual(['c0', 'c1', 'c5'])
    const [h, l] = dropNeighborsMany(model, block, ['c0', 'c1'], 'c5', null)
    expect([h, l]).toEqual([null, 'c2'])
    expect(shownRows(build(['c5'], spreadWrites(rankSpace(model), ['c0', 'c1'], h, l, T)))).toEqual(['c0', 'c1', 'c5'])
  })

  it('lands below the last capped row it does not carry, skipping the rows it carries', () => {
    const model = build(['c4', 'c5'])
    const block = model.groups[0].blocks[0]
    expect(shownRows(model)).toEqual(['c0', 'c1', 'c4', 'c5'])
    expect(dropNeighborsMany(model, block, ['c1', 'c4'], 'c0', 'c5')).toEqual(['c0', 'c2'])
  })

  it('takes a group entirely past the cap as it is', () => {
    const model = build(['c4', 'c5'])
    const block = model.groups[0].blocks[0]
    expect(dropNeighborsMany(model, block, ['c4', 'c5'], 'c0', 'c1')).toEqual(['c0', 'c1'])
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

describe('an Unpin', () => {
  // `pin` is the oldest row in its folder and carries a stale drag override from before it was pinned,
  // so falling back to where it ranked would put it last — past the folder's cap. `ahead`, in another
  // folder, ranks past the clock: the Unpin must land above it too.
  const groups = [
    group('/w/one', [conv('newer', T - 1000), conv('older', T - 2000), conv('pin', T - 9000)]),
    group('/w/two', [conv('ahead', T - 4000)])
  ]
  const before = { groups, rowRanks: { ahead: T + 500, pin: T - 9500 } }
  const model = buildSidebar(input({ ...before, pinned: ['pin'] }))

  it('lifts the row above every unpinned row, in every folder', () => {
    expect(unpinWrites(model, 'pin', T)).toEqual({ pin: T + 501 })
  })

  it('makes the row the first unpinned row, in its folder and in All mode', () => {
    const rowRanks = { ...before.rowRanks, ...unpinWrites(model, 'pin', T) }
    const folders = buildSidebar(input({ groups, rowRanks }))
    expect(folders.groups.find((g) => g.key === '/w/one')?.blocks[0].rows.map((r) => r.sessionId)).toEqual([
      'pin',
      'newer'
    ])
    const all = buildSidebar(input({ mode: 'all', groups, rowRanks, limits: { ...LIMITS, allCap: 9 } }))
    expect(visibleRows(all).map((r) => r.sessionId)).toEqual(['pin', 'ahead', 'newer', 'older'])
  })

  it('writes nothing for a row that is not pinned, or a row the model does not hold', () => {
    expect(unpinWrites(model, 'newer', T)).toEqual({})
    expect(unpinWrites(model, 'nobody', T)).toEqual({})
  })
})

describe('turning on moving stopped conversations down', () => {
  // Live b1 outranks live a1, in another folder, with a stopped row between them; ids and the order the
  // model lists rows in both put a1 first, so only rank order puts b1 on top. b2 carries an override
  // past the clock, which the lift must clear. b1's terminal shows no dot and still counts as live.
  // Live p is pinned.
  const groups = [
    group('/w/a', [conv('a0', T), conv('a1', T - 1500), conv('a2', T - 1200), conv('p', T - 3000)]),
    group('/w/b', [conv('b0', T - 500), conv('b1', T - 1000), conv('b2', T - 2500)])
  ]
  const rowRanks = { b2: T + 500 }
  const base = {
    groups,
    rowRanks,
    pinned: ['p'],
    liveState: states({ b1: null }),
    limits: { ...LIMITS, folderCap: 9, allCap: 9 }
  }
  const ptys = [pty('a1'), pty('b1'), pty('p')]
  const model = buildSidebar(input({ ...base, ptys }))
  const allOrder = (over: Partial<SidebarInput>): string[] =>
    visibleRows(buildSidebar(input({ ...base, ptys, ...over, mode: 'all' }))).map((r) => r.sessionId)

  it('lifts every live unpinned row above every unpinned row, in the order they had', () => {
    expect(allOrder({})).toEqual(['p', 'b2', 'a0', 'b0', 'b1', 'a2', 'a1'])
    const writes = liftLiveWrites(model, T)
    expect(writes).toEqual({ b1: T + 502, a1: T + 501 })
    const lifted = { ...rowRanks, ...writes }
    expect(allOrder({ rowRanks: lifted })).toEqual(['p', 'b1', 'a1', 'b2', 'a0', 'b0', 'a2'])
    expect(shape(buildSidebar(input({ ...base, ptys, rowRanks: lifted })))).toEqual([
      { key: '/w/b', collapsed: false, withheld: 0, blocks: [['un:/w/b', 'b1', 'b2', 'b0']] },
      { key: '/w/a', collapsed: false, withheld: 0, blocks: [['pin:/w/a', 'p'], ['un:/w/a', 'a1', 'a0', 'a2']] }
    ])
  })

  it('writes nothing when no unpinned row is live', () => {
    expect(liftLiveWrites(buildSidebar(input({ ...base, ptys: [pty('p')] })), T)).toEqual({})
    expect(liftLiveWrites(buildSidebar(input(base)), T)).toEqual({})
  })

  it('lifts only when the setting turns on, never when it stays on, stays off or turns off', () => {
    expect(liveFirstToggleWrites(model, false, true, T)).toEqual({ b1: T + 502, a1: T + 501 })
    expect(liveFirstToggleWrites(model, true, true, T)).toEqual({})
    expect(liveFirstToggleWrites(model, false, false, T)).toEqual({})
    expect(liveFirstToggleWrites(model, true, false, T)).toEqual({})
  })
})

describe('rows that stop', () => {
  // Before: a, b, c and pinned d are live, e never was, and a placeholder terminal runs. After: a's and
  // d's terminals are gone, c's conversation is gone with its terminal, and the placeholder has bound
  // to its real conversation.
  const convs = [conv('a', T), conv('b', T - 1000), conv('c', T - 2000), conv('d', T - 3000), conv('e', T - 4000)]
  const before = buildSidebar(
    input({
      groups: [group('/w/r', convs)],
      ptys: [pty('a'), pty('b'), pty('c'), pty('d'), pty('ph', { projectRoot: '/w/r', provisional: true })],
      pinned: ['d']
    })
  )
  const after = buildSidebar(
    input({
      groups: [group('/w/r', [...convs.filter((m) => m.sessionId !== 'c'), conv('real', T + 5)])],
      ptys: [pty('b'), pty('real', { projectRoot: '/w/r' })],
      pinned: ['d']
    })
  )

  it('reports a row that lost its terminal, and none still live, gone, pinned or never live', () => {
    expect(before.rows.get('ph')?.live).toBe(true)
    expect(stoppedRows(true, before, after)).toEqual(['a'])
  })

  it('reports nothing without a model to compare with', () => {
    expect(stoppedRows(true, null, after)).toEqual([])
  })

  it('reports nothing with the setting off, so a stop moves nothing', () => {
    expect(stoppedRows(false, before, after)).toEqual([])
  })

  it('gives no fold unless a row stopped, so the store is left alone', () => {
    expect(stopFold(false, before, after, 'folders')).toBeNull()
    expect(stopFold(true, null, after, 'folders')).toBeNull()
    expect(stopFold(true, after, after, 'folders')).toBeNull()
  })

  it('gives the fold that moves the rows that stopped, read from the new model', () => {
    // Stopped `a` sits above live `b`, with stopped `e` below: it moves between them.
    const fold = stopFold(true, before, after, 'folders')
    expect(fold).not.toBeNull()
    const stored = { elsewhere: T + 7 }
    expect(fold!(stored)).toEqual({ elsewhere: T + 7, a: T - 2500 })
    expect(fold!(stored)).toEqual(sinkStopped(stored, after, 'folders', ['a']))
  })
})

/** /w/a: a1, which has just stopped, over live a2. /w/b: stopped b1, ranked above a2 in All, then live
 *  b2 and stopped b3. a1's folder run ends at a2, directly above another folder's live b2 in All. */
const FOLDER_RUN_ABOVE_LIVE = [
  group('/w/a', [conv('a1', T), conv('a2', T - 2000)]),
  group('/w/b', [conv('b1', T - 1000), conv('b2', T - 3000), conv('b3', T - 4000)])
]

describe('moving a stopped row down', () => {
  // /w/r, top first: r0, which has just stopped, then live r1 and r2, stopped r3 and live r4. Pinned pl
  // is live, with a seed between r2 and r3. /w/o's stopped o0 ranks between r1 and r2, so the live run
  // below r0 ends at r1 in All and at r2 in its folder; past r3 sits live r4, which a row sent below
  // every live row would land under. In its own folder o0 has stopped o1 below it, and in All live r2.
  // /w/o's o1 has just stopped too, above live o2 and o3, the last rows anywhere.
  const groups = [
    group('/w/r', [
      conv('r0', T),
      conv('r1', T - 1000),
      conv('r2', T - 2000),
      conv('pl', T - 2700),
      conv('r3', T - 3000),
      conv('r4', T - 4000)
    ]),
    group('/w/o', [conv('o0', T - 1500), conv('o1', T - 5000), conv('o2', T - 6000), conv('o3', T - 7000)])
  ]
  const build = (rowRanks: RankOverrides = {}, over: Partial<SidebarInput> = {}): SidebarModel =>
    buildSidebar(
      input({
        groups,
        ptys: ['r1', 'r2', 'pl', 'r4', 'o2', 'o3'].map((id) => pty(id)),
        pinned: ['pl'],
        rowRanks,
        limits: { ...LIMITS, folderCap: 9, allCap: 20 },
        ...over
      })
    )
  const model = build()
  const inFolder = (m: SidebarModel, key: string): string[] =>
    m.groups.find((g) => g.key === key)!.blocks.flatMap((b) => b.rows.map((r) => r.sessionId))
  const inAll = (rowRanks: RankOverrides): string[] =>
    visibleRows(build(rowRanks, { mode: 'all' })).map((r) => r.sessionId)

  it('moves past its folder’s live rows in Folders mode when they run lower than All’s, never past a stopped row there', () => {
    const moved = sinkStopped({}, model, 'folders', ['r0'])
    expect(moved).toEqual({ r0: T - 2500 })
    expect(inFolder(build(moved), '/w/r')).toEqual(['pl', 'r1', 'r2', 'r0', 'r3', 'r4'])
  })

  it('moves past the live rows directly below it across every folder in All mode', () => {
    const moved = sinkStopped({}, model, 'all', ['r0'])
    expect(moved).toEqual({ r0: T - 1250 })
    expect(inAll(moved)).toEqual(['pl', 'r1', 'r0', 'o0', 'r2', 'r3', 'r4', 'o1', 'o2', 'o3'])
  })

  it('lands at the bottom when the live rows run to the end', () => {
    expect(sinkStopped({}, model, 'folders', ['o1'])).toEqual({ o1: T - 7001 })
    expect(sinkStopped({}, model, 'all', ['o1'])).toEqual({ o1: T - 7001 })
  })

  it('in Folders mode, moves past the live rows directly below it in All when its folder has none', () => {
    const moved = sinkStopped({}, model, 'folders', ['o0'])
    expect(moved).toEqual({ o0: T - 2500 })
    expect(inAll(moved)).toEqual(['pl', 'r0', 'r1', 'r2', 'o0', 'r3', 'r4', 'o1', 'o2', 'o3'])
    expect(inFolder(build(moved), '/w/o')).toEqual(['o0', 'o1', 'o2', 'o3'])
  })

  it('leaves a row that is live or not listed', () => {
    const stored = {}
    expect(sinkStopped(stored, model, 'folders', ['r1', 'nobody'])).toBe(stored)
  })

  it('writes a move once, however many windows fold it in, reading ranks from the store', () => {
    const once = sinkStopped({}, model, 'folders', ['r0'])
    expect(sinkStopped(once, build(once), 'folders', ['r0'])).toBe(once)
    // A window whose model still ranks r0 where it was, folding into a store another window has
    // already written the move to.
    expect(model.rows.get('r0')!.rank).toBe(T)
    expect(sinkStopped(once, model, 'folders', ['r0'])).toBe(once)
    // Every move, in either mode — including one whose folder's run ends above another folder's live
    // row in All — leaves a second fold nothing to do.
    const other = (rowRanks: RankOverrides = {}): SidebarModel =>
      buildSidebar(input({ groups: FOLDER_RUN_ABOVE_LIVE, ptys: [pty('a2'), pty('b2')], rowRanks, limits: { ...LIMITS, folderCap: 9 } }))
    const moves: [(rowRanks?: RankOverrides) => SidebarModel, string, SidebarMode][] = [
      [build, 'r0', 'all'],
      [build, 'o0', 'folders'],
      [build, 'o0', 'all'],
      [build, 'o1', 'folders'],
      [build, 'o1', 'all'],
      [other, 'a1', 'folders']
    ]
    for (const [make, id, mode] of moves) {
      const moved = sinkStopped({}, make(), mode, [id])
      expect(Object.keys(moved)).toEqual([id])
      expect(sinkStopped(moved, make(moved), mode, [id])).toBe(moved)
    }
  })

  it('keeps several rows that stop at once in their order', () => {
    // s0 and s1 stop together above live s2 and s3, with stopped s4 below. Taken top first, s0 would
    // find s1 still under it and stay.
    const five = (rowRanks: RankOverrides = {}): SidebarModel =>
      buildSidebar(
        input({
          groups: [group('/w/s', [0, 1, 2, 3, 4].map((i) => conv(`s${i}`, T - i * 1000)))],
          ptys: [pty('s2'), pty('s3')],
          rowRanks,
          limits: { ...LIMITS, folderCap: 9 }
        })
      )
    const moved = { s0: T - 3250, s1: T - 3500 }
    expect(sinkStopped({}, five(), 'folders', ['s0', 's1'])).toEqual(moved)
    expect(sinkStopped({}, five(), 'folders', ['s1', 's0'])).toEqual(moved)
    expect(inFolder(five(moved), '/w/s')).toEqual(['s2', 's3', 's0', 's1', 's4'])
  })

  it('stops at a stopped row the rail leaves out, as at any other, so every window writes alike', () => {
    // Top first: stopped A, stopped B — hidden by the user, so the filter keeps it off the rail — live
    // C and stopped D. Read from the rows on screen, C would sit directly below A and A would move;
    // another window, filtered to show hidden rows, would see B there and leave it.
    const model = buildSidebar(
      input({
        groups: [group('/w/h', [conv('A', T), conv('B', T - 1000), conv('C', T - 2000), conv('D', T - 3000)])],
        ptys: [pty('C')],
        userHidden: { rows: new Set(['B']), folders: new Set() },
        limits: { ...LIMITS, folderCap: 9 }
      })
    )
    expect(visibleRows(model).map((r) => r.sessionId)).toEqual(['A', 'C', 'D'])
    expect(model.rows.has('B')).toBe(true)
    const stored = {}
    expect(sinkStopped(stored, model, 'folders', ['A'])).toBe(stored)
  })
})

describe('moving a stopped row down in Folders mode, in both views', () => {
  const ids = (m: SidebarModel): string[] => visibleRows(m).map((r) => r.sessionId)
  const inFolder = (m: SidebarModel, key: string): string[] =>
    m.groups.find((g) => g.key === key)!.blocks.flatMap((b) => b.rows.map((r) => r.sessionId))
  const builder =
    (groups: ConversationGroup[], live: string[]) =>
    (rowRanks: RankOverrides = {}, over: Partial<SidebarInput> = {}): SidebarModel =>
      buildSidebar(
        input({
          groups,
          ptys: live.map((id) => pty(id)),
          rowRanks,
          limits: { ...LIMITS, folderCap: 9, allCap: 9 },
          ...over
        })
      )

  it('moves a row whose folder has no live row below it past the live rows below it in All', () => {
    // /w/a: live a1 over stopped a2; /w/b: b1 over stopped b2. Turning the setting on lifted the live
    // rows, so All reads b1, a1, a2, b2. Then b1 stops: nothing live follows it in its folder, a1 does
    // in All.
    const groups = [
      group('/w/a', [conv('a1', T - 1000), conv('a2', T - 1500)]),
      group('/w/b', [conv('b1', T - 500), conv('b2', T - 2000)])
    ]
    const lifted = liftLiveWrites(builder(groups, ['a1', 'b1'])(), T)
    expect(lifted).toEqual({ b1: T + 1, a1: T })
    const build = builder(groups, ['a1'])
    const moved = sinkStopped(lifted, build(lifted), 'folders', ['b1'])
    expect(moved).toEqual({ b1: T - 750, a1: T })
    expect(ids(build(moved, { mode: 'all' }))).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(inFolder(build(moved), '/w/b')).toEqual(['b1', 'b2'])
    // Stopped a2 has nothing below it in its folder and stopped b2 below it in All: it stays.
    expect(sinkStopped(moved, build(moved), 'folders', ['a2'])).toBe(moved)
  })

  it('lands below All’s live run when it ends lower than the folder’s, the folder’s order intact', () => {
    // /w/a: a1 has just stopped, over live a2 and stopped a3. /w/b's live b1 and b2 sit above a2 and
    // above a3 in All. The folder's run ends at a2, All's at b2, below it.
    const groups = [
      group('/w/a', [conv('a1', T), conv('a2', T - 2000), conv('a3', T - 4000)]),
      group('/w/b', [conv('b1', T - 1000), conv('b2', T - 3000), conv('b3', T - 5000)])
    ]
    const build = builder(groups, ['a2', 'b1', 'b2'])
    const moved = sinkStopped({}, build(), 'folders', ['a1'])
    expect(moved).toEqual({ a1: T - 3500 })
    expect(ids(build(moved, { mode: 'all' }))).toEqual(['b1', 'a2', 'b2', 'a1', 'a3', 'b3'])
    expect(inFolder(build(moved), '/w/a')).toEqual(['a2', 'a1', 'a3'])
  })

  it('lands below the folder’s live run when it ends lower than All’s, directly below its last row in All too', () => {
    // /w/r: r0 has just stopped, over live r1 and r2 and stopped r3. /w/o's stopped o0 sits between r1
    // and r2 in All, and stopped o1 between r2 and r3. All's run ends at r1, the folder's at r2: r0
    // lands between r2 and o1, not midway down to r3, which would put it under o1.
    const groups = [
      group('/w/r', [conv('r0', T), conv('r1', T - 1000), conv('r2', T - 2000), conv('r3', T - 4400)]),
      group('/w/o', [conv('o0', T - 1500), conv('o1', T - 3000)])
    ]
    const build = builder(groups, ['r1', 'r2'])
    const moved = sinkStopped({}, build(), 'folders', ['r0'])
    expect(moved).toEqual({ r0: T - 2500 })
    expect(inFolder(build(moved), '/w/r')).toEqual(['r1', 'r2', 'r0', 'r3'])
    expect(ids(build(moved, { mode: 'all' }))).toEqual(['r1', 'o0', 'r2', 'r0', 'o1', 'r3'])
    // All mode reads All's run alone, so r0 never passes o0 there.
    expect(sinkStopped({}, build(), 'all', ['r0'])).toEqual({ r0: T - 1250 })
  })

  it('goes on past the live rows below its folder’s run in All, so a second window finds nothing to move', () => {
    // a1's folder run ends at a2, and live b2 follows a2 in All. Landing directly below a2 would leave
    // a1 above b2, and the next window to fold the stop would move it on: where it ended up would depend
    // on how many windows are open.
    const build = builder(FOLDER_RUN_ABOVE_LIVE, ['a2', 'b2'])
    const first = sinkStopped({}, build(), 'folders', ['a1'])
    expect(first).toEqual({ a1: T - 3500 })
    expect(ids(build(first, { mode: 'all' }))).toEqual(['b1', 'a2', 'b2', 'a1', 'b3'])
    expect(inFolder(build(first), '/w/a')).toEqual(['a2', 'a1'])
    expect(sinkStopped(first, build(first), 'folders', ['a1'])).toBe(first)
    // Past every live row there, not just the first.
    const more = builder(
      [FOLDER_RUN_ABOVE_LIVE[0], group('/w/b', [conv('b1', T - 1000), conv('b2', T - 3000), conv('b4', T - 3500), conv('b3', T - 4000)])],
      ['a2', 'b2', 'b4']
    )
    const past = sinkStopped({}, more(), 'folders', ['a1'])
    expect(past).toEqual({ a1: T - 3750 })
    expect(sinkStopped(past, more(past), 'folders', ['a1'])).toBe(past)
  })
})

describe('an Unpin while stopped conversations move down', () => {
  // Pinned, in order: stopped p1, live q1, stopped p2, live q2. Unpinned: live u1 and u2, then stopped
  // u3. The model still has the rows pinned, as App's is when it runs an Unpin. The store carries p1's
  // override from before it was pinned, which the lift must replace, and an entry for a row elsewhere,
  // which must survive.
  const groups = [
    group('/w/u', [
      conv('u1', T),
      conv('u2', T - 1000),
      conv('u3', T - 2000),
      conv('p1', T - 9000),
      conv('q1', T - 9100),
      conv('p2', T - 9200),
      conv('q2', T - 9300)
    ])
  ]
  const pins = ['p1', 'q1', 'p2', 'q2']
  const build = (pinned: string[], rowRanks: RankOverrides = {}): SidebarModel =>
    buildSidebar(
      input({
        groups,
        ptys: ['q1', 'q2', 'u1', 'u2'].map((id) => pty(id)),
        pinned,
        rowRanks,
        limits: { ...LIMITS, folderCap: 9 }
      })
    )
  const model = build(pins)
  const order = (pinned: string[], rowRanks: RankOverrides): string[] =>
    build(pinned, rowRanks).groups[0].blocks.flatMap((b) => b.rows.map((r) => r.sessionId))

  const stored = { p1: T - 9500, elsewhere: T + 7 }

  it('moves a stopped row down past the live rows it was lifted above', () => {
    const writes = unpinWrites(model, 'p1', T)
    expect(writes).toEqual({ p1: T + 1 })
    const moved = unpinRanks(stored, writes, model, 'folders', ['p1'], true)
    expect(moved).toEqual({ p1: T - 1500, elsewhere: T + 7 })
    expect(order(['q1', 'p2', 'q2'], moved)).toEqual(['q1', 'p2', 'q2', 'u1', 'u2', 'p1', 'u3'])
  })

  it('leaves a live row at the top', () => {
    const lifted = unpinRanks(stored, unpinWrites(model, 'q1', T), model, 'folders', ['q1'], true)
    expect(lifted).toEqual({ p1: T - 9500, q1: T + 1, elsewhere: T + 7 })
    expect(order(['p1', 'p2', 'q2'], lifted)).toEqual(['p1', 'p2', 'q2', 'q1', 'u1', 'u2', 'u3'])
  })

  it('keeps a group’s live rows on top and its stopped rows below them, each in their order', () => {
    const writes = liftWrites(rankSpace(model), pins, T)
    expect(writes).toEqual({ p1: T + 4, q1: T + 3, p2: T + 2, q2: T + 1 })
    const moved = unpinRanks(stored, writes, model, 'folders', pins, true)
    expect(moved).toEqual({ p1: T - 1250, q1: T + 3, p2: T - 1500, q2: T + 1, elsewhere: T + 7 })
    expect(order([], moved)).toEqual(['q1', 'q2', 'u1', 'u2', 'p1', 'p2', 'u3'])
  })

  it('only lifts with the setting off, one row or a group', () => {
    const one = unpinRanks(stored, unpinWrites(model, 'p1', T), model, 'folders', ['p1'], false)
    expect(one).toEqual({ p1: T + 1, elsewhere: T + 7 })
    expect(order(['q1', 'p2', 'q2'], one)).toEqual(['q1', 'p2', 'q2', 'p1', 'u1', 'u2', 'u3'])
    const all = unpinRanks(stored, liftWrites(rankSpace(model), pins, T), model, 'folders', pins, false)
    expect(all).toEqual({ p1: T + 4, q1: T + 3, p2: T + 2, q2: T + 1, elsewhere: T + 7 })
  })

  it('moves a stopped row from a folder with no live rows below the live rows in All', () => {
    // Folders mode. /w/p's pinned p and unpinned p2 are both stopped; /w/l has live l1 and l2 over
    // stopped l3. The lift puts p above every row; nothing live follows it in its own folder.
    const twoFolders = [
      group('/w/p', [conv('p', T - 9000), conv('p2', T - 3000)]),
      group('/w/l', [conv('l1', T), conv('l2', T - 1000), conv('l3', T - 2000)])
    ]
    const buildTwo = (pinned: string[], rowRanks: RankOverrides = {}, over: Partial<SidebarInput> = {}): SidebarModel =>
      buildSidebar(
        input({
          groups: twoFolders,
          ptys: [pty('l1'), pty('l2')],
          pinned,
          rowRanks,
          limits: { ...LIMITS, folderCap: 9, allCap: 9 },
          ...over
        })
      )
    const pinnedModel = buildTwo(['p'])
    const writes = unpinWrites(pinnedModel, 'p', T)
    expect(writes).toEqual({ p: T + 1 })
    const moved = unpinRanks({}, writes, pinnedModel, 'folders', ['p'], true)
    expect(moved).toEqual({ p: T - 1500 })
    expect(visibleRows(buildTwo([], moved, { mode: 'all' })).map((r) => r.sessionId)).toEqual(['l1', 'l2', 'p', 'l3', 'p2'])
    expect(buildTwo([], moved).groups.find((g) => g.key === '/w/p')!.blocks[0].rows.map((r) => r.sessionId)).toEqual([
      'p',
      'p2'
    ])
  })

  it('orders a group’s stopped rows by the ranks the lift gave them, not by their seeds or pin order', () => {
    // Pinned p then q, both stopped, with p started after q; live l1 and l2 over stopped s. The group
    // lifts in the order q, p — as a tab group's does, in tab order — so the lift puts q above p. Taken
    // by seed or by pin order, q would move first, find p still below it, and stay put.
    const pinGroups = [
      group('/w/u', [conv('l1', T), conv('l2', T - 1000), conv('s', T - 2000), conv('q', T - 9000), conv('p', T - 8000)])
    ]
    const buildPins = (pinned: string[], rowRanks: RankOverrides = {}): SidebarModel =>
      buildSidebar(
        input({ groups: pinGroups, ptys: [pty('l1'), pty('l2')], pinned, rowRanks, limits: { ...LIMITS, folderCap: 9 } })
      )
    const pinnedModel = buildPins(['p', 'q'])
    const writes = liftWrites(rankSpace(pinnedModel), ['q', 'p'], T)
    expect(writes).toEqual({ q: T + 2, p: T + 1 })
    const moved = unpinRanks({}, writes, pinnedModel, 'folders', ['q', 'p'], true)
    expect(moved).toEqual({ q: T - 1250, p: T - 1500 })
    expect(buildPins([], moved).groups[0].blocks.flatMap((b) => b.rows.map((r) => r.sessionId))).toEqual([
      'l1',
      'l2',
      'q',
      'p',
      's'
    ])
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
    delegated: new Set(['b-hidden']),
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

describe('the user hide and the filter', () => {
  const hide = (rows: string[] = [], folders: string[] = []): SidebarInput['userHidden'] => ({
    rows: new Set(rows),
    folders: new Set(folders)
  })
  const ids = (model: SidebarModel): string[] => visibleRows(model).map((r) => r.sessionId)
  const outside = (model: SidebarModel): string[] => visibleRows(model).filter((r) => r.outside).map((r) => r.sessionId)
  // What a row is grayed by: its own hide, its folder's, or nothing — read whatever the filter.
  const grayed = (model: SidebarModel): [string, string | null][] => visibleRows(model).map((r) => [r.sessionId, r.hiddenBy])

  it('leaves a hidden conversation out of the rail but in the rows a Resume writes into', () => {
    // Placed rows must keep it: filtering where rows are placed would leave a Resume nothing to lift.
    const model = buildSidebar(
      input({ groups: [group('/w/a', [conv('kept', T - 1), conv('gone', T - 2)])], userHidden: hide(['gone']) })
    )
    expect(ids(model)).toEqual(['kept'])
    expect(model.rows.has('gone')).toBe(true)
    expect(resumeWrites(model, 'gone', T + 5)).toEqual({ gone: T + 5 })
    expect(model.filteredOut).toBe(1)
  })

  it('hides a folder in All mode too, where it has no header', () => {
    const groups = [group('/w/a', [conv('a1', T - 1)]), group('/w/b', [conv('b1', T - 2)])]
    expect(ids(buildSidebar(input({ mode: 'all', groups, userHidden: hide([], ['/w/a']) })))).toEqual(['b1'])
  })

  it('leaves the other folders’ labels as they were', () => {
    // Labels computed only over the folders shown would shorten /w/y/app's to `app` once its twin hides.
    const model = buildSidebar(
      input({
        groups: [group('/w/x/app', [conv('x1', T - 1)]), group('/w/y/app', [conv('y1', T - 2)])],
        userHidden: hide([], ['/w/x/app'])
      })
    )
    expect(model.groups.map((g) => [g.key, g.label])).toEqual([['/w/y/app', 'y/app']])
    expect(model.labels.get('/w/x/app')).toBe('x/app')
  })

  it('applies before the cap, so a hidden row takes no slot', () => {
    // Cap 2: with r1 hidden, r2 and r3 both fit. Capping first would withhold r3 behind the hidden r1.
    const model = buildSidebar(
      input({ groups: [group('/w/a', [conv('r1', T - 1), conv('r2', T - 2), conv('r3', T - 3)])], userHidden: hide(['r1']) })
    )
    expect(shape(model)).toEqual([{ key: '/w/a', collapsed: false, withheld: 0, blocks: [['un:/w/a', 'r2', 'r3']] }])
  })

  it('keeps what is on screen, outside the filter, but not what is merely running', () => {
    // `shown` is open in a pane; `running` has a terminal and nothing more. The cap's own exemption
    // covers both, so a filter borrowing it would keep `running` too.
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('plain', T - 1), conv('shown', T - 2), conv('running', T - 3)])],
        ptys: [pty('running')],
        active: new Set(['shown']),
        userHidden: hide(['shown', 'running'])
      })
    )
    expect(ids(model)).toEqual(['plain', 'shown'])
    expect(outside(model)).toEqual(['shown'])
    expect(model.filteredOut).toBe(1)
  })

  it('marks a folder hidden only by its own hide, not by its conversations’', () => {
    const base = { groups: [group('/w/a', [conv('a1', T - 1), conv('a2', T - 2)])], active: new Set(['a1']) }
    expect(buildSidebar(input({ ...base, userHidden: hide([], ['/w/a']) })).groups[0].folderHidden).toBe(true)
    expect(buildSidebar(input({ ...base, userHidden: hide(['a1', 'a2']), filter: new Set(['hidden']) })).groups[0].folderHidden).toBe(false)
  })

  it('shows only what is hidden under Hidden, keeping what is on screen, grayed by its hide alone', () => {
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('open', T - 1), conv('own', T - 2)]), group('/w/b', [conv('b1', T - 3)])],
        active: new Set(['open']),
        userHidden: hide(['own'], ['/w/b']),
        filter: new Set(['hidden'])
      })
    )
    expect(ids(model)).toEqual(['open', 'own', 'b1'])
    expect(outside(model)).toEqual(['open'])
    // Gray means hidden in every filter: the hidden rows gray under Hidden too, the open one does not.
    expect(grayed(model)).toEqual([['open', null], ['own', 'self'], ['b1', 'folder']])
  })

  it('narrows to running conversations under Live, dropping folders with none, and never brings a hidden one back', () => {
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('idle', T - 1), conv('live', T - 2), conv('hiddenLive', T - 3)]), group('/w/b', [conv('b1', T - 4)])],
        ptys: [pty('live'), pty('hiddenLive')],
        userHidden: hide(['hiddenLive']),
        filter: new Set(['live'])
      })
    )
    expect(keys(model)).toEqual(['/w/a'])
    expect(ids(model)).toEqual(['live'])
  })

  it('requires every criterion: Hidden and Live is what is both', () => {
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('hiddenIdle', T - 1), conv('hiddenLive', T - 2), conv('live', T - 3)])],
        ptys: [pty('hiddenLive'), pty('live')],
        userHidden: hide(['hiddenIdle', 'hiddenLive']),
        filter: new Set(['hidden', 'live'])
      })
    )
    expect(ids(model)).toEqual(['hiddenLive'])
  })

  it('does not bold a folder for a conversation it leaves out, which the bell still lists', () => {
    // `quiet` shares the folder, so the folder still shows: only the asking row is gone.
    const model = buildSidebar(
      input({
        groups: [group('/w/a', [conv('quiet', T - 1), conv('asks', T - 2)])],
        ptys: [pty('quiet'), pty('asks')],
        liveState: states({ asks: 'asking' }),
        userHidden: hide(['asks'])
      })
    )
    expect(model.groups[0].wantsAttention).toBe(false)
    expect(model.needsYou).toEqual(['asks'])
  })

  it('gives hidden folders none of the folders that start expanded', () => {
    // autoExpand is 2. /w/a is first but hidden, so /w/b and /w/c open and /w/d starts collapsed;
    // counting /w/a would collapse /w/c as well.
    const groups = ['a', 'b', 'c', 'd'].map((n, i) => group(`/w/${n}`, [conv(n, T - i)]))
    const model = buildSidebar(input({ groups, userHidden: hide([], ['/w/a']) }))
    expect(model.groups.map((g) => [g.key, g.collapsed])).toEqual([
      ['/w/b', false],
      ['/w/c', false],
      ['/w/d', true]
    ])
  })

  it('counts what it leaves out among the search matches only', () => {
    const base = {
      groups: [group('/w/a', [conv('kept', T - 1), conv('gone', T - 2), conv('also', T - 3)])],
      userHidden: hide(['gone', 'also'])
    }
    expect(buildSidebar(input({ ...base, search: new Set(['gone']) })).filteredOut).toBe(1)
    expect(buildSidebar(input({ ...base, search: new Set(['kept']) })).filteredOut).toBe(0)
  })
})
