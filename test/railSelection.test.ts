import { describe, expect, it } from 'vitest'
import type { ConversationMeta, LiveState, PtyState } from '../src/shared/types'
import type { SidebarRow } from '../src/renderer/lib/sidebarModel'
import {
  NO_PICKS,
  dragCarry,
  escapeTakesPicks,
  extendPicks,
  pickSeed,
  pickedTargets,
  prunePicks,
  railMenuGroup,
  railMenuTarget,
  retargetPicks,
  togglePick,
  type RailSelection
} from '../src/renderer/lib/railSelection'

/**
 * A rail selection is a tab selection in one fixed scope (tabSelection.test.ts covers the algebra);
 * these pin what is the rail's own — the seed, the order a range and a command walk, what a drag
 * carries, and what a menu opened on a pick is about.
 */

function pty(sessionId: string, over: Partial<PtyState> = {}): PtyState {
  return {
    ptyId: `pty-${sessionId}`,
    sessionId,
    agent: 'claude',
    cwd: '/repo',
    projectRoot: '/repo',
    title: 'Conversation',
    status: 'idle',
    lastActivity: 20,
    startedAt: 10,
    inputRequestedAt: null,
    origin: 'new',
    provisional: false,
    usedByUser: false,
    parkedJob: null,
    registryStatus: null,
    ownedHere: true,
    ...over
  }
}

function meta(sessionId: string, over: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    sessionId,
    agent: 'claude',
    cwd: '/repo',
    title: 'Conversation',
    preview: '',
    gitBranch: null,
    mtime: 0,
    messageCount: 3,
    version: null,
    sizeBytes: 0,
    model: null,
    outputTokens: 0,
    inputTokens: 0,
    contextTokens: 0,
    firstActivityAt: null,
    ...over
  }
}

function row(
  sessionId: string,
  over: { pty?: PtyState | null; meta?: Partial<ConversationMeta>; pinned?: boolean; liveState?: LiveState | null; hiddenBy?: SidebarRow['hiddenBy'] } = {}
): SidebarRow {
  return {
    sessionId,
    pty: over.pty ?? null,
    meta: meta(sessionId, over.meta),
    pinned: over.pinned ?? false,
    liveState: over.liveState ?? null,
    rank: 0,
    hiddenBy: over.hiddenBy ?? null,
    outside: false
  }
}

const picks = (ids: string[], anchor: string | null = ids[ids.length - 1] ?? null): RailSelection => ({
  pane: 0,
  ids: new Set(ids),
  anchor
})

describe('pickSeed', () => {
  it('seeds with the selected row while the rail shows it', () => {
    expect(pickSeed('b', ['a', 'b', 'c'])).toBe('b')
  })

  it('seeds with nothing when the selected conversation is off the rail', () => {
    // Filtered out, or in a collapsed folder: a pick nobody can see must not be made.
    expect(pickSeed('z', ['a', 'b', 'c'])).toBeNull()
    expect(pickSeed(null, ['a', 'b'])).toBeNull()
  })
})

describe('togglePick', () => {
  it('a first ⌘-click picks the selected row too, so two rows end up picked', () => {
    const sel = togglePick(NO_PICKS, pickSeed('a', ['a', 'b', 'c']), 'c')
    expect([...sel.ids]).toEqual(['a', 'c'])
    expect(sel.anchor).toBe('c')
  })

  it('with the selected row off the rail, picks only the row clicked', () => {
    const sel = togglePick(NO_PICKS, pickSeed('z', ['a', 'b', 'c']), 'c')
    expect([...sel.ids]).toEqual(['c'])
  })
})

describe('extendPicks', () => {
  // Rail order runs across folders and blocks: x's pins, then x's rows, then y's.
  const order = ['x-pin', 'x-1', 'x-2', 'y-pin', 'y-1']

  it('takes the run from the selected row when nothing is picked, across folders', () => {
    const sel = extendPicks(NO_PICKS, order, 'y-pin', pickSeed('x-1', order))
    expect([...sel.ids]).toEqual(['x-1', 'x-2', 'y-pin'])
    expect(sel.anchor).toBe('x-1')
  })

  it('ranges from the anchor rather than the selected row once one is set, in either direction', () => {
    const sel = extendPicks(picks(['y-1'], 'y-1'), order, 'x-2', pickSeed('x-pin', order))
    expect([...sel.ids]).toEqual(['x-2', 'y-pin', 'y-1'])
  })
})

describe('prunePicks', () => {
  it('drops a pick the rail no longer shows', () => {
    const sel = prunePicks(picks(['a', 'b', 'c'], 'b'), ['a', 'c'])
    expect([...sel.ids]).toEqual(['a', 'c'])
    expect(sel.anchor).toBeNull()
  })

  it('returns the same selection when every pick is still on the rail', () => {
    const sel = picks(['a', 'c'])
    expect(prunePicks(sel, ['a', 'b', 'c'])).toBe(sel)
  })

  it('clears when the rail shows none of them — collapsed, say', () => {
    expect(prunePicks(picks(['a', 'b']), [])).toBe(NO_PICKS)
  })
})

describe('retargetPicks', () => {
  it('moves a placeholder’s pick to its real conversation', () => {
    const sel = retargetPicks(picks(['tmp', 'b'], 'tmp'), 'tmp', 'real')
    expect([...sel.ids].sort()).toEqual(['b', 'real'])
    expect(sel.anchor).toBe('real')
  })
})

describe('pickedTargets', () => {
  it('a command on a pick acts on every pick, in rail order rather than the order picked', () => {
    expect(pickedTargets(new Set(['c', 'a']), 'a', ['a', 'b', 'c'])).toEqual(['a', 'c'])
  })

  it('a command on a row outside the picks acts on that row alone', () => {
    expect(pickedTargets(new Set(['a', 'c']), 'b', ['a', 'b', 'c'])).toEqual(['b'])
  })
})

describe('dragCarry', () => {
  it('carries the picks in the pressed row’s block, in block order, and leaves the rest', () => {
    // Picked out of order, and one pick in another block.
    expect(dragCarry(new Set(['c', 'other', 'a']), 'c', ['a', 'b', 'c', 'd'])).toEqual(['a', 'c'])
  })

  it('a press on a row outside the picks carries that row alone', () => {
    expect(dragCarry(new Set(['a', 'c']), 'b', ['a', 'b', 'c'])).toEqual(['b'])
  })
})

describe('railMenuTarget', () => {
  it('an indexed running conversation can be placed, filed and marked', () => {
    expect(railMenuTarget(row('a', { pty: pty('a'), pinned: true, liveState: 'awaiting', hiddenBy: 'self' }))).toEqual({
      id: 'a',
      linked: true,
      movable: true,
      live: true,
      pinned: true,
      unread: true,
      hidden: 'self'
    })
  })

  it('reads a question waiting for the user as unread, and a finished, seen turn as read', () => {
    expect(railMenuTarget(row('a', { pty: pty('a'), liveState: 'asking' })).unread).toBe(true)
    expect(railMenuTarget(row('a', { pty: pty('a'), liveState: 'quiet' })).unread).toBe(false)
    expect(railMenuTarget(row('a', { pty: pty('a'), liveState: 'working' })).unread).toBe(false)
  })

  it('a new conversation before its first message can be placed but not filed', () => {
    const t = railMenuTarget(row('a', { pty: pty('a'), meta: { provisional: true, messageCount: 0 } }))
    expect(t.movable).toBe(true)
    expect(t.linked).toBe(false)
  })

  it('a terminal that stands for no conversation can only be stopped', () => {
    const t = railMenuTarget(row('a', { pty: pty('a', { provisional: true }), meta: { provisional: true, messageCount: 0 } }))
    expect(t).toMatchObject({ movable: false, linked: false, live: true })
  })
})

describe('railMenuGroup', () => {
  const rows = [row('a'), row('b', { pinned: true }), row('c')]

  it('a menu on a pick is about every pick, in rail order', () => {
    const g = railMenuGroup(new Set(['c', 'b']), 'c', rows)
    expect(g?.size).toBe(2)
    expect(g?.move).toEqual(['b', 'c'])
    expect(g?.pin).toEqual(['c'])
    expect(g?.unpin).toEqual(['b'])
  })

  it('a menu on a row outside the picks is about that row alone', () => {
    expect(railMenuGroup(new Set(['a', 'b']), 'c', rows)).toBeNull()
  })

  it('a single pick is an anchor, not a group', () => {
    expect(railMenuGroup(new Set(['a']), 'a', rows)).toBeNull()
  })
})

describe('escapeTakesPicks', () => {
  const terminal = { inTerminal: true, dragging: false, menuOpen: false }

  it('takes an Escape pressed in the terminal, so it clears the picks instead of reaching the session', () => {
    expect(escapeTakesPicks(terminal)).toBe(true)
  })

  it('leaves an Escape pressed anywhere else to the app\'s own Escape order', () => {
    expect(escapeTakesPicks({ ...terminal, inTerminal: false })).toBe(false)
  })

  it('leaves it to a drag, whose Escape cancels the drag', () => {
    expect(escapeTakesPicks({ ...terminal, dragging: true })).toBe(false)
  })

  it('leaves it to an open menu, whose Escape closes the menu', () => {
    expect(escapeTakesPicks({ ...terminal, menuOpen: true })).toBe(false)
  })
})
