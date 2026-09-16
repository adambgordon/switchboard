import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import type { TurnSnapshot } from '../src/shared/turnActivity'

const CWD = '/repo'

describe('PtyManager live-session cap', () => {
  let mgr: PtyManager
  let exits: string[]

  /** Stand in for the conversation index, which is what feeds the manager its transcript facts. */
  const indexed = (entries: Record<string, TurnSnapshot>): void => {
    mgr.setTurnSnapshots(new Map(Object.entries(entries)))
  }

  beforeEach(() => {
    ptys.spawns = 0
    ptys.writes = []
    ptys.feeds = []
    exits = []
    mgr = new PtyManager({ resolveBindings: async () => [] })
    mgr.on('exit', (ptyId: string) => exits.push(ptyId))
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
})
