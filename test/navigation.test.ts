import { describe, expect, it } from 'vitest'
import { NavigationCoordinator, type NavigationHost } from '../src/main/navigation'
import type { NavigationCommand, NavigationVisit } from '../src/shared/navigation'

const v = (sessionId: string, view: NavigationVisit['view'] = 'transcript'): NavigationVisit => ({ sessionId, view })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function harness(restore?: NavigationHost['restoreTerminal'], immediateFocus = true) {
  const owners = new Map([['A', 1], ['B', 2], ['C', 3]])
  const live = new Set([1, 2, 3])
  const commands: Array<{ windowId: number; command: NavigationCommand }> = []
  const cancels: Array<[number, number]> = []
  const focuses: number[] = []
  const restores: string[] = []
  const nav = new NavigationCoordinator({
    ownerOf: (id) => owners.get(id),
    exists: (id) => live.has(id),
    activate: (windowId, command) => commands.push({ windowId, command: { ...command } }),
    cancel: (id, token) => { cancels.push([id, token]) },
    focus: (id) => { focuses.push(id); if (immediateFocus) nav.focused(id) },
    restoreTerminal: restore ?? (async (_id, sessionId) => { restores.push(sessionId); return true })
  })
  const ack = (sent = commands.at(-1)!) => {
    nav.complete(sent.windowId, sent.command.requestId, v(sent.command.sessionId, sent.command.view ?? 'transcript'))
  }
  const seed = () => {
    nav.report(1, v('A'), true); nav.report(2, v('B', 'terminal'), true); nav.report(3, v('C'), true)
  }
  return { nav, owners, live, commands, cancels, focuses, restores, ack, seed }
}

describe('NavigationCoordinator', () => {
  it('skips hidden history stops in both directions without erasing the route', async () => {
    const h = harness()
    h.seed()
    for (const window of [1, 2, 3]) h.nav.focused(window)
    h.nav.setHiddenSessions(new Set(['B']))
    h.nav.go(3, -1); await flush(); h.ack()
    expect(h.commands.at(-1)?.command.sessionId).toBe('A')
    expect(h.nav.state.cursor).toBe(0)
    h.nav.go(1, 1); await flush(); h.ack()
    expect(h.commands.at(-1)?.command.sessionId).toBe('C')
    expect(h.nav.state.entries.map((visit) => visit.sessionId)).toEqual(['A', 'B', 'C'])
    expect(h.restores).toEqual([])
  })

  it('keeps the cursor and pending command when a stale hidden reveal or blocked step arrives', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.focused(2); h.nav.focused(3)
    h.nav.setHiddenSessions(new Set(['A', 'B']))
    const before = h.nav.state
    h.nav.go(3, -1)
    expect(h.nav.state).toBe(before)
    expect(h.commands).toEqual([])
    h.nav.reveal(3, 'C', 'preview')
    h.nav.reveal(3, 'B', 'preview')
    h.ack()
    expect(h.focuses).toEqual([3])
    expect(h.commands.map((c) => c.command.sessionId)).toEqual(['C'])
    h.nav.report(3, v('B'), true)
    expect(h.nav.state).toBe(before)
  })

  it('cancels a newly hidden terminal replay before its handoff finishes', async () => {
    let finish = (_result: boolean) => {}
    let current = () => true
    const h = harness((_window, _session, isCurrent) => {
      current = isCurrent
      return new Promise((resolve) => { finish = resolve })
    })
    h.seed(); h.nav.focused(1); h.nav.focused(2); h.nav.focused(3)
    h.nav.go(3, -1)
    expect(current()).toBe(true)
    h.nav.setHiddenSessions(new Set(['B']))
    expect(current()).toBe(false)
    expect(h.cancels).toEqual([[2, 1]])
    finish(true); await flush()
    expect(h.commands).toEqual([])
    expect(h.focuses).toEqual([])
    h.nav.go(3, -1); await flush(); h.ack()
    expect(h.commands.at(-1)?.command.sessionId).toBe('A')
  })

  it('ignores late acknowledgements and cached focus visits after a target becomes hidden', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.reveal(1, 'B', 'preview')
    const stale = h.commands[0]
    h.nav.setHiddenSessions(new Set(['B']))
    h.ack(stale); h.nav.focused(2)
    expect(h.focuses).toEqual([])
    expect(h.nav.state.entries.map((visit) => visit.sessionId)).toEqual(['A'])
  })

  it('steps over a retired terminal without erasing the route', async () => {
    // A new agent terminal carries a placeholder id until the OS proves which conversation it holds.
    // Reclaimed before that happens, the id names nothing — so Back must pass over it rather than
    // land on a row backed by no conversation. Asserted separately from the hidden case because the
    // two arrive by different routes and only share the skip.
    const h = harness()
    h.seed()
    for (const window of [1, 2, 3]) h.nav.focused(window)
    h.nav.retire('B')
    h.nav.go(3, -1); await flush(); h.ack()
    expect(h.commands.at(-1)?.command.sessionId).toBe('A')
    // The stop survives: deleting entries would shift the cursor under the user.
    expect(h.nav.state.entries.map((visit) => visit.sessionId)).toEqual(['A', 'B', 'C'])
    h.nav.go(1, 1); await flush(); h.ack()
    expect(h.commands.at(-1)?.command.sessionId).toBe('C')
  })

  it('refuses to reveal a retired session or re-record a late report of one', () => {
    const h = harness()
    h.seed()
    for (const window of [1, 2, 3]) h.nav.focused(window)
    h.nav.retire('B')
    const before = h.commands.length
    h.nav.reveal(1, 'B', 'preview')
    expect(h.commands.length).toBe(before)
    // A renderer that has not caught up still names the dead id. Recording it would make a stop
    // nobody can return to the newest one, and Back would then have to skip its way out again.
    h.nav.report(3, v('B'), true)
    expect(h.nav.state.entries.map((visit) => visit.sessionId)).toEqual(['A', 'B', 'C'])
  })

  it('interrupts a navigation already in flight toward a terminal that gets retired', async () => {
    const h = harness()
    h.seed()
    for (const window of [1, 2, 3]) h.nav.focused(window)
    h.nav.go(3, -1); await flush()
    const inFlight = h.commands.at(-1)!
    expect(inFlight.command.sessionId).toBe('B')
    h.nav.retire('B')
    h.ack(inFlight)
    // The target answered a command for a terminal that no longer exists; completing it would focus
    // that window onto a dead row and record the visit.
    expect(h.focuses).toEqual([])
    expect(h.nav.state.entries.map((visit) => visit.sessionId)).toEqual(['A', 'B', 'C'])
  })

  it('drops a retired id from window routing so refocusing cannot resurrect it', () => {
    const h = harness()
    h.seed()
    for (const window of [1, 2, 3]) h.nav.focused(window)
    expect(h.nav.state.entries.map((visit) => visit.sessionId)).toEqual(['A', 'B', 'C'])
    h.nav.retire('B')
    // Window 2's CACHED visit still names B, and `focused` records from that cache rather than from
    // a fresh report — so the report-time guard cannot catch this one. Left uncleared, a refocus
    // truncates Forward and appends the dead id as the newest stop.
    h.nav.focused(2)
    expect(h.nav.state.entries.map((visit) => visit.sessionId)).toEqual(['A', 'B', 'C'])
    expect(h.nav.state.away).toBe(true)
  })

  it('continues complete Back/Forward round trips from any of three windows', async () => {
    const h = harness()
    h.seed()
    for (const id of [1, 2, 3, 1]) h.nav.focused(id)
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A', 'B', 'C', 'A'])
    for (const [from, direction] of [[1, -1], [3, -1], [2, -1], [1, 1], [2, 1], [3, 1]] as const) {
      h.nav.go(from, direction); await flush(); h.ack()
    }
    expect(h.focuses).toEqual([3, 2, 1, 2, 3, 1])
    expect(h.restores).toEqual(['B', 'B'])
    expect(h.nav.state.cursor).toBe(3)
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A', 'B', 'C', 'A'])
  })

  it('records return to an unchanged local tab after another window was visited', async () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.focused(2); h.nav.focused(1)
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A', 'B', 'A'])
    h.nav.go(1, -1); await flush(); h.ack()
    h.nav.focused(1)
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A', 'B', 'A'])
    h.nav.go(1, -1); await flush()
    expect(h.commands.at(-1)?.windowId).toBe(2)
  })

  it('does not record background reports or automatic mode changes', () => {
    const h = harness()
    h.seed(); h.nav.focused(1)
    h.nav.report(2, v('X'), true)
    h.nav.report(1, v('A', 'terminal'), false)
    expect(h.nav.state.entries).toEqual([{ sessionId: 'A', view: 'transcript' }])
    h.nav.report(1, v('A', 'terminal'), true)
    expect(h.nav.state.entries).toEqual([
      { sessionId: 'A', view: 'transcript' }, { sessionId: 'A', view: 'terminal' }
    ])
  })

  it('records a remote reveal once after commitment, preserving preview mode', () => {
    const h = harness()
    h.seed(); h.nav.focused(1)
    h.nav.reveal(1, 'B', 'preview')
    const sent = h.commands.at(-1)!
    expect(sent.command).toMatchObject({ sessionId: 'B', mode: 'preview', view: null, kind: 'visit' })
    expect(h.focuses).toEqual([])
    h.nav.report(2, v('B'), true)
    h.ack(sent); h.ack(sent)
    expect(h.focuses).toEqual([2])
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A', 'B'])
  })

  it('acknowledges an already-active destination without duplicating a visit', () => {
    const h = harness()
    h.seed(); h.nav.focused(1)
    h.nav.reveal(2, 'A', 'persistent')
    h.ack()
    expect(h.focuses).toEqual([1])
    expect(h.nav.state.entries).toEqual([{ sessionId: 'A', view: 'transcript' }])
  })

  it('reopens a closed tab locally and does not reconstruct its former window', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.focused(2)
    h.owners.delete('A')
    h.nav.go(2, -1)
    expect(h.commands.at(-1)).toMatchObject({ windowId: 2, command: { sessionId: 'A', mode: 'preview' } })
    h.ack()
    expect(h.nav.state.cursor).toBe(0)
  })

  it('falls back to Formatted while preserving recorded visits and Forward', async () => {
    const h = harness(async () => false)
    h.seed(); h.nav.focused(2); h.nav.focused(1)
    h.nav.go(1, -1); await flush()
    expect(h.commands.at(-1)?.command.view).toBe('transcript')
    h.ack()
    expect(h.nav.state.entries).toEqual([
      { sessionId: 'B', view: 'terminal' }, { sessionId: 'A', view: 'transcript' }
    ])
    h.nav.go(2, 1); h.ack()
    expect(h.nav.state.cursor).toBe(1)
  })

  it('supersedes delayed handoffs and stale acknowledgements during rapid navigation', async () => {
    const completions: Array<() => void> = []
    const valid: Array<() => boolean> = []
    const h = harness((_id, _session, current) => {
      valid.push(current)
      return new Promise((resolve) => completions.push(() => resolve(true)))
    })
    h.seed(); h.nav.focused(1); h.nav.focused(2); h.nav.focused(3)
    h.nav.go(3, -1) // B, waiting for handoff
    h.nav.go(3, -1) // A, ready
    const stale = h.commands.at(-1)!
    h.nav.go(3, 1) // B again, a new handoff
    expect(valid[0]()).toBe(false)
    expect(valid[1]()).toBe(true)
    completions[0](); completions[1](); await flush()
    expect(h.commands.map((c) => c.command.sessionId)).toEqual(['A', 'B'])
    h.ack(stale)
    expect(h.focuses).toEqual([])
    h.ack()
    expect(h.focuses).toEqual([2])
    expect(h.nav.state.cursor).toBe(1)
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A', 'B', 'C'])
  })

  it('a manual navigation cancels a pending replay and branches from the shared cursor', async () => {
    let finish = (_value: boolean) => {}
    let current = () => true
    const h = harness((_id, _session, guard) => {
      current = guard
      return new Promise((resolve) => { finish = resolve })
    })
    h.seed(); h.nav.focused(2); h.nav.focused(1)
    h.nav.go(1, -1)
    h.nav.interrupt()
    h.nav.report(1, v('D'), true)
    expect(current()).toBe(false)
    finish(true); await flush()
    expect(h.commands).toEqual([])
    expect(h.focuses).toEqual([])
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['B', 'D'])
  })

  it('ignores a stale foreground snapshot while replay is preparing', async () => {
    let finish = (_value: boolean) => {}
    const h = harness(() => new Promise((resolve) => { finish = resolve }))
    h.seed(); h.nav.focused(1); h.nav.focused(2); h.nav.focused(3)
    h.nav.go(3, -1)
    const history = h.nav.state
    h.nav.report(3, v('C'), true)
    expect(h.nav.state).toBe(history)
    expect(h.nav.state.cursor).toBe(1)
    finish(true); await flush(); h.ack()
    expect(h.nav.state.entries.map((v) => v.sessionId)).toEqual(['A', 'B', 'C'])
  })

  it('re-resolves once if the target closes before acknowledging', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.focused(3)
    h.nav.go(3, -1)
    const stale = h.commands.at(-1)!
    h.live.delete(1); h.owners.delete('A'); h.nav.closed(1)
    expect(h.commands.at(-1)).toMatchObject({ windowId: 3, command: { sessionId: 'A' } })
    h.ack(stale); expect(h.focuses).toEqual([])
    h.ack(); expect(h.focuses).toEqual([3])
  })

  it('waits for a booting renderer to subscribe and report before sending activation', () => {
    const h = harness()
    h.nav.report(1, v('A'), true); h.nav.focused(1)
    h.nav.reveal(1, 'B', 'preview')
    expect(h.commands).toEqual([])
    h.nav.focused(2)
    h.nav.report(2, v('B'), true, 5)
    expect(h.commands).toHaveLength(1)
    expect(h.commands[0].command.targetRevision).toBe(5)
    h.ack()
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A', 'B'])
  })

  it('tags activation with the destination revision, including newer uncommitted intent', () => {
    const h = harness()
    h.seed(); h.nav.focused(1)
    h.nav.report(1, v('A'), true, 90)
    h.nav.report(2, v('B'), true, 7)
    h.nav.reveal(1, 'B', 'preview')
    expect(h.commands.at(-1)?.command.targetRevision).toBe(7)
    h.nav.intent(2, 8)
    h.nav.reveal(1, 'B', 'preview')
    expect(h.commands.at(-1)?.command.targetRevision).toBe(8)
  })

  it('ignores duplicate and foreign acknowledgements while native focus is still pending', () => {
    const h = harness(undefined, false)
    h.seed(); h.nav.focused(1); h.nav.reveal(1, 'B', 'preview')
    const command = h.commands.at(-1)!.command
    h.nav.complete(3, command.requestId, v('B'))
    expect(h.focuses).toEqual([])
    expect(h.commands).toHaveLength(1)
    h.ack(); h.ack()
    expect(h.focuses).toEqual([2])
    h.nav.focused(2)
    expect(h.nav.state.entries.map((v) => v.sessionId)).toEqual(['A', 'B'])
  })

  it('ignores an old token when two commands target the same window and conversation', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.reveal(1, 'B', 'preview')
    const stale = h.commands[0]
    h.nav.reveal(1, 'B', 'preview')
    h.ack(stale)
    expect(h.focuses).toEqual([])
    h.ack()
    expect(h.focuses).toEqual([2])
    expect(h.nav.state.entries.map((v) => v.sessionId)).toEqual(['A', 'B'])
  })

  it('remembers the committed destination view when that window is revisited', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.reveal(1, 'B', 'preview'); h.ack()
    h.nav.focused(1); h.nav.focused(2)
    expect(h.nav.state.entries).toEqual([
      { sessionId: 'A', view: 'transcript' }, { sessionId: 'B', view: 'transcript' },
      { sessionId: 'A', view: 'transcript' }, { sessionId: 'B', view: 'transcript' }
    ])
  })

  it('bounds failed activation to one retry', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.reveal(1, 'B', 'preview')
    h.nav.complete(2, h.commands.at(-1)!.command.requestId, null)
    expect(h.commands).toHaveLength(2)
    h.nav.complete(2, h.commands.at(-1)!.command.requestId, null)
    expect(h.commands).toHaveLength(2)
    expect(h.focuses).toEqual([])
  })

  it('restarts an in-flight placeholder handoff using the proven identity', async () => {
    const pending: Array<{ id: string; current: () => boolean; finish: () => void }> = []
    const h = harness((_window, id, current) => new Promise((resolve) => {
      pending.push({ id, current, finish: () => resolve(true) })
    }))
    h.seed(); h.nav.focused(2); h.nav.focused(1); h.nav.go(1, -1)
    h.owners.delete('B'); h.owners.set('REAL', 2)
    h.nav.rekey('B', 'REAL')
    expect(pending.map((p) => p.id)).toEqual(['B', 'REAL'])
    expect(pending[0].current()).toBe(false)
    expect(pending[1].current()).toBe(true)
    pending[0].finish(); pending[1].finish(); await flush()
    expect(h.commands).toHaveLength(1)
    expect(h.commands[0].command.sessionId).toBe('REAL')
    h.ack()
    expect(h.nav.state.entries.map((v) => v.sessionId)).toEqual(['REAL', 'A'])
  })

  it('preserves Welcome drift and records no new stop during its Back replay', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.report(1, null, true)
    h.nav.go(1, 1); expect(h.commands).toEqual([])
    h.nav.go(1, -1); h.ack()
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['A'])
    expect(h.nav.state.away).toBe(false)
  })

  it('rekeys all windows and visits but retargets only a focused correction', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.focused(2); h.nav.focused(1)
    h.nav.rekey('A', 'REAL')
    h.nav.retarget(2, 'B', 'OTHER')
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['REAL', 'B', 'REAL'])
    h.nav.retarget(1, 'REAL', 'CORRECTED')
    expect(h.nav.state.entries.map((e) => e.sessionId)).toEqual(['REAL', 'B', 'CORRECTED'])
  })

  it('does not retarget a replay cursor for a correction in the still-background destination', async () => {
    let finish = (_value: boolean) => {}
    const h = harness(() => new Promise((resolve) => { finish = resolve }))
    h.seed(); h.nav.focused(2); h.nav.focused(1)
    h.nav.go(1, -1)
    // The cursor names B, but focus has not left window 1 while its Terminal handoff waits.
    h.nav.retarget(2, 'B', 'OTHER')
    expect(h.nav.state.entries.map((v) => v.sessionId)).toEqual(['B', 'A'])
    finish(false); await flush(); h.ack()
    expect(h.commands.at(-1)?.command.sessionId).toBe('B')
  })

  it('re-resolves when ownership changes while activation is pending', () => {
    const h = harness()
    h.seed(); h.nav.focused(1); h.nav.reveal(1, 'C', 'preview')
    const stale = h.commands.at(-1)!
    h.owners.set('C', 2)
    h.ack(stale)
    expect(h.focuses).toEqual([])
    expect(h.commands.at(-1)?.windowId).toBe(2)
    h.ack()
    expect(h.focuses).toEqual([2])
  })
})
