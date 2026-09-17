import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cover for the WIRING of the live-session cap — the seam the pure `evictionPolicy` tests cannot
 * reach. The policy decides which terminal may be stopped; this decides what the manager tells it,
 * and that translation is where the bug lived: `write()` once counted every byte as user input, but
 * xterm answers an agent's startup terminal queries through the very same channel, so every
 * terminal was marked used within milliseconds of booting and no untouched one was ever reclaimed.
 *
 * Driving the real PtyManager is the point. A fake would just restate the assumption under test.
 *
 * node-pty is a native module built for Electron's ABI and cannot load under vitest; no real
 * process is needed, since what is under test is the manager's own bookkeeping.
 */
const ptys = vi.hoisted(() => ({
  spawns: 0,
  writes: [] as string[],
  /** Each PTY's onData callback, by spawn index — lets a test push real terminal output so the
   *  runtime input-request timestamp is SET by the production scanner rather than faked. */
  feeds: [] as ((data: string) => void)[]
}))
vi.mock('node-pty', () => ({
  spawn: () => {
    const index = ptys.spawns++
    let exited: ((e: { exitCode: number }) => void) | null = null
    return {
      pid: 1000 + index,
      cols: 80,
      rows: 30,
      write: (data: string) => ptys.writes.push(data),
      resize: () => {},
      kill: () => exited?.({ exitCode: 0 }),
      pause: () => {},
      resume: () => {},
      onData: (cb: (data: string) => void) => {
        ptys.feeds[index] = cb
        return { dispose: () => {} }
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exited = cb
        return { dispose: () => {} }
      }
    }
  }
}))

import { PtyManager } from '../src/main/pty/manager'
import { RECENT_USE_GRACE_MS } from '../src/main/pty/evictionPolicy'
import type { TurnSnapshot } from '../src/shared/turnActivity'

const CWD = '/repo'
/**
 * Session ids for the registry fixtures. Claude's records are keyed by a real session UUID and the
 * parser rejects anything else, so the short ids the rest of this suite uses satisfy the manager but
 * are silently unmatchable here — a registry fixture must use these, or every status arrives as null
 * and the assertion holds for the wrong reason.
 */
const S1 = '6aa9d622-7904-479f-99c5-343458067a72'
const S2 = '5364d27e-bc41-4d50-95a6-74e708ac6069'

describe('PtyManager live-session cap', () => {
  let mgr: PtyManager
  let exits: string[]
  /** How many times the active set was republished — the renderer's only view of this state. */
  let announced: number

  /** Stand in for the conversation index, which is what feeds the manager its transcript facts. */
  const indexed = (entries: Record<string, TurnSnapshot>): void => {
    mgr.setTurnSnapshots(new Map(Object.entries(entries)))
  }

  beforeEach(() => {
    ptys.spawns = 0
    ptys.writes = []
    ptys.feeds = []
    exits = []
    announced = 0
    mgr = new PtyManager({ resolveBindings: async () => [] })
    mgr.on('exit', (ptyId: string) => exits.push(ptyId))
    mgr.on('active-changed', () => {
      announced += 1
    })
    mgr.setMaxLive(2)
  })

  it('reclaims an untouched terminal to make room', () => {
    const first = mgr.startNew(CWD, 'codex')
    mgr.startNew(CWD, 'codex')
    mgr.startNew(CWD, 'codex')
    expect(exits).toEqual([first.ptyId])
  })

  it('does not treat written bytes as use, so a terminal an agent queried stays reclaimable', () => {
    // THE REGRESSION. xterm replies to an agent's DA1/CPR queries through the same `sendInput`
    // channel a keystroke uses, so this is what a brand-new terminal looks like a few ms after boot.
    const first = mgr.startNew(CWD, 'codex')
    mgr.write(first.ptyId, '\x1b[?1;2c')
    mgr.write(first.ptyId, '\x1b[1;1R')
    mgr.startNew(CWD, 'codex')
    mgr.startNew(CWD, 'codex')
    expect(exits).toEqual([first.ptyId])
  })

  it('protects a terminal a person actually used, taking an untouched newer one instead', () => {
    const used = mgr.startNew(CWD, 'codex')
    const untouched = mgr.startNew(CWD, 'codex')
    mgr.markUsed(used.ptyId)
    mgr.startNew(CWD, 'codex')
    expect(exits).toEqual([untouched.ptyId])
  })

  it('never reclaims a terminal that is on screen', () => {
    const watched = mgr.startNew(CWD, 'codex')
    const offscreen = mgr.startNew(CWD, 'codex')
    mgr.setVisiblePtyIds(new Set([watched.ptyId]))
    mgr.startNew(CWD, 'codex')
    expect(exits).toEqual([offscreen.ptyId])
  })

  it('reclaims several at once when the cap was lowered under a running set', () => {
    // setMaxLive deliberately closes nothing by itself, so the set sits above the cap until the next
    // spawn — which then has to free more than one slot or it never converges.
    mgr.setMaxLive(8)
    const spawned = [0, 1, 2, 3].map(() => mgr.startNew(CWD, 'codex').ptyId)
    mgr.setMaxLive(2)
    expect(exits).toEqual([])
    mgr.startNew(CWD, 'codex')
    expect(exits).toEqual([spawned[0], spawned[1], spawned[2]])
  })

  it('lets the set grow rather than stop a terminal someone is using and watching', () => {
    const a = mgr.startNew(CWD, 'codex')
    const b = mgr.startNew(CWD, 'codex')
    mgr.markUsed(a.ptyId)
    mgr.markUsed(b.ptyId)
    mgr.setVisiblePtyIds(new Set([a.ptyId, b.ptyId]))
    mgr.startNew(CWD, 'codex')
    expect(exits).toEqual([])
  })

  it('reclaims a resumed session whose in_progress turn belongs to a previous process', () => {
    // Quitting mid-turn leaves a dangling `in_progress` that no later process ever finishes, so
    // resuming produces a resting session the raw turn-state calls busy. Passing that field through
    // protected every such session permanently — an ineffective cap for anyone who resumes
    // interrupted conversations. The spawn times below postdate the recorded activity, which is the
    // only thing that reveals it.
    const first = mgr.resume('s1', CWD, 'claude')
    const second = mgr.resume('s2', CWD, 'claude')
    indexed({
      s1: { turnState: 'in_progress', lastActivityAt: first.startedAt - 60_000 },
      s2: { turnState: 'in_progress', lastActivityAt: second.startedAt - 60_000 }
    })
    mgr.startNew(CWD, 'claude')
    expect(exits).toEqual([first.ptyId])
  })

  it('protects a terminal holding a question the transcript never recorded', () => {
    // An agent can raise an approval or plan-mode prompt after the turn completes and never persist
    // it, so the transcript reads `awaiting` while the prompt is still on screen. The runtime
    // timestamp is the only evidence, and stopping the terminal discards the ask.
    const asked = mgr.resume('s1', CWD, 'codex')
    const plain = mgr.resume('s2', CWD, 'codex')
    // Activity is dated well before the notification: the runtime signal counts only while it is
    // strictly newer than the transcript, so a same-millisecond fixture would prove nothing.
    indexed({
      s1: { turnState: 'awaiting', lastActivityAt: asked.startedAt - 60_000 },
      s2: { turnState: 'awaiting', lastActivityAt: plain.startedAt - 60_000 }
    })
    ptys.feeds[0]?.('\x1b]9;Approval requested: run tests\x07')
    mgr.startNew(CWD, 'codex')
    expect(exits).toEqual([plain.ptyId])
  })

  it('republishes the active set when answering clears a question', () => {
    // Clearing the request in main is not enough: the renderer holds the previous snapshot, and
    // nothing else republishes this one. `markBusy` emits only on a busy TRANSITION, and a
    // repainting agent TUI never leaves `busy`, so the row can pulse `asking` for a prompt that has
    // already been answered until some unrelated change refreshes it. Driven through the real
    // scanner so the timestamp is set the way production sets it.
    const asked = mgr.resume('s1', CWD, 'codex')
    indexed({ s1: { turnState: 'awaiting', lastActivityAt: asked.startedAt - 60_000 } })
    ptys.feeds[0]?.('\x1b]9;Approval requested: run tests\x07')
    announced = 0
    mgr.markUsed(asked.ptyId)
    expect(announced).toBe(1)
  })

  it('stays silent for ordinary use, with no question outstanding', () => {
    // The same call on the same terminal, differing only in whether a request was pending — so a
    // fix that simply announces on every input report fails here. This arrives on the typing path,
    // and rebroadcasting the whole active set to every window while someone types would be a real
    // cost for a value no consumer reads.
    const plain = mgr.resume('s1', CWD, 'codex')
    indexed({ s1: { turnState: 'awaiting', lastActivityAt: plain.startedAt - 60_000 } })
    announced = 0
    mgr.markUsed(plain.ptyId)
    mgr.markUsed(plain.ptyId)
    expect(announced).toBe(0)
  })

  it('stops protecting a question once the user has responded to it', () => {
    // The bug: a request detected from output is cleared by nothing if the user DECLINES. Accepting
    // lets the transcript overtake the timestamp; declining leaves no trace at all, so the terminal
    // read as blocked on the user for the rest of its life — and `asking` is protection the cap
    // never overrides. A person typing here IS the response.
    //
    // Driven through the real scanner and the real markUsed, because the clearing has to survive the
    // path production takes: the notification is parsed out of genuine terminal output, and the clear
    // arrives on the channel the renderer reports keystrokes over.
    //
    // Two things make this fixture awkward, and both are load-bearing. Answering also starts the
    // 30-second recency guard, so the terminal is protected for a reason unrelated to the request
    // and the clock has to be moved past it. And the OTHER terminal has to be taken out of the
    // running, because both are idle afterwards and it is the least recently used of the two — so it
    // would be chosen first whether or not the request was ever cleared, and the test would pass
    // against the bug.
    vi.useFakeTimers()
    try {
      const base = Date.now()
      const declined = mgr.resume('s1', CWD, 'codex')
      const other = mgr.resume('s2', CWD, 'codex')
      indexed({
        s1: { turnState: 'awaiting', lastActivityAt: declined.startedAt - 60_000 },
        s2: { turnState: 'awaiting', lastActivityAt: other.startedAt - 60_000 }
      })
      ptys.feeds[0]?.('\x1b]9;Approval requested: run tests\x07')
      mgr.markUsed(declined.ptyId)
      mgr.setVisiblePtyIds(new Set([other.ptyId]))
      vi.setSystemTime(base + RECENT_USE_GRACE_MS + 1)
      mgr.startNew(CWD, 'codex')
      // The request is still well inside STALE_REQUEST_MS, so nothing but the clear can explain
      // this terminal being eligible at all.
      expect(exits).toEqual([declined.ptyId])
    } finally {
      vi.useRealTimers()
    }
  })

})

/**
 * The registry path, driven end to end: a real file on disk, the real monitor, the real manager.
 *
 * Nothing here is injected at the manager's boundary, because the part most likely to break is the
 * chain itself — the monitor keys records by SESSION id and the cap reasons about PTYs, and a
 * mismatch between the two would leave every session statusless while every unit test still passed.
 */
describe('PtyManager live-session cap — Claude reporting itself busy', () => {
  let root: string
  let mgr: PtyManager
  let exits: string[]

  beforeEach(() => {
    ptys.spawns = 0
    ptys.feeds = []
    exits = []
    root = mkdtempSync(join(tmpdir(), 'sb-cap-registry-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** One live-session record, as Claude writes them: named by pid, keyed by session id. */
  const registryRecord = (pid: number, sessionId: string, status: string): void => {
    writeFileSync(join(root, `${pid}.json`), JSON.stringify({ pid, sessionId, kind: 'interactive', status }))
  }

  const build = (): PtyManager => {
    mgr = new PtyManager({
      resolveBindings: async () => [],
      // Every pid in the fixture is alive; process liveness is the monitor's own concern and is
      // covered there, against a stub whose pids are not real processes.
      claudeParkedJobs: { sessionsRoot: root, isProcessAlive: () => true }
    })
    mgr.on('exit', (ptyId: string) => exits.push(ptyId))
    mgr.setMaxLive(2)
    return mgr
  }

  it('protects a session Claude reports as working with nothing in its transcript', () => {
    // A subagent runs inside the parent session's process, so killing the terminal destroys it —
    // while the parent may write no transcript for the whole duration, leaving the session looking
    // like an empty terminal. Claude's own registry is the only signal that catches this.
    //
    // Written BEFORE the spawn: registering a PTY triggers a read, which is how the status is in
    // place by the time the next spawn consults the cap.
    registryRecord(1000, S1, 'busy')
    const m = build()
    const host = m.resume(S1, CWD, 'claude')
    const resting = m.resume(S2, CWD, 'claude')
    // Deliberately NO index entry for S1: an attributed transcript would protect it for an
    // unrelated reason and the fixture would prove nothing.
    m.setTurnSnapshots(
      new Map([[S2, { turnState: 'awaiting' as const, lastActivityAt: resting.startedAt - 60_000 }]])
    )
    m.startNew(CWD, 'claude')
    expect(exits).toEqual([resting.ptyId])
    expect(host.ptyId).not.toBe(resting.ptyId)
  })

  it('reclaims that same session once Claude reports it idle', () => {
    // Identical fixture but for the one value, because "protected while busy" is otherwise satisfied
    // by an implementation that protects an unattributable terminal unconditionally — which is the
    // rule that was just removed from this policy.
    registryRecord(1000, S1, 'idle')
    const m = build()
    const host = m.resume(S1, CWD, 'claude')
    const resting = m.resume(S2, CWD, 'claude')
    m.setTurnSnapshots(
      new Map([[S2, { turnState: 'awaiting' as const, lastActivityAt: resting.startedAt - 60_000 }]])
    )
    m.startNew(CWD, 'claude')
    // An untouched terminal with no transcript outranks a finished conversation, so `idle` must
    // contribute nothing of its own for this to hold.
    expect(exits).toEqual([host.ptyId])
  })

  it('does not attribute one session status to another terminal', () => {
    // The mismatch this suite exists for: keying by PTY rather than by session would hand the second
    // session's `busy` to whichever terminal happened to register first. The record names S2, and it
    // is S1 — a finished conversation, so ordinarily the LAST thing taken — that must still go.
    registryRecord(1000, S2, 'busy')
    const m = build()
    const first = m.resume(S1, CWD, 'claude')
    m.resume(S2, CWD, 'claude')
    m.setTurnSnapshots(
      new Map([[S1, { turnState: 'awaiting' as const, lastActivityAt: first.startedAt - 60_000 }]])
    )
    m.startNew(CWD, 'claude')
    expect(exits).toEqual([first.ptyId])
  })
})
