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
const ptys = vi.hoisted(() => ({ spawns: 0, writes: [] as string[] }))
vi.mock('node-pty', () => ({
  spawn: () => {
    ptys.spawns += 1
    let exited: ((e: { exitCode: number }) => void) | null = null
    return {
      pid: 1000 + ptys.spawns,
      cols: 80,
      rows: 30,
      write: (data: string) => ptys.writes.push(data),
      resize: () => {},
      kill: () => exited?.({ exitCode: 0 }),
      pause: () => {},
      resume: () => {},
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exited = cb
        return { dispose: () => {} }
      }
    }
  }
}))

import { PtyManager } from '../src/main/pty/manager'

const CWD = '/repo'

describe('PtyManager live-session cap', () => {
  let mgr: PtyManager
  let exits: string[]

  beforeEach(() => {
    ptys.spawns = 0
    ptys.writes = []
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
})
