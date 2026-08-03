import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end cover for new-Codex binding THROUGH PtyManager — the seam the pure
 * matchProvisionalCodex tests can't reach: that a renderer keystroke is what stamps `firstSubmitAt`,
 * that the internal boot write does NOT, and that the stamp reaches the matcher.
 *
 * node-pty is a native module built for Electron's ABI, so it cannot load under vitest — and no real
 * process is needed here, since what's under test is the manager's own bookkeeping. Stubbing it keeps
 * this deterministic (and keeps the suite free of `electron`, per the testing convention).
 *
 * Fake timers are the point, not a convenience: submit ORDER is the correlation key, and driving the
 * clock is the only way to pin it down exactly — by hand it's whatever the user's timing happened to
 * be, which is precisely what made the original bug so hard to pin down.
 */
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 1,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} })
  })
}))

import { PtyManager } from '../src/main/pty/manager'

const CWD = '/repo'
/** Longer than the 2500ms boot fallback, so boot() has definitely fired and written to the pty. */
const PAST_BOOT = 5000

const cand = (sessionId: string, firstActivityAt: number, cwd = CWD) => ({
  sessionId,
  cwd,
  firstActivityAt
})

describe('PtyManager new-Codex binding', () => {
  let mgr: PtyManager
  let bound: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    mgr = new PtyManager()
    bound = []
    mgr.on('bound', (ptyId: string, _old: string, newId: string) => bound.push(`${ptyId}->${newId}`))
  })

  afterEach(() => {
    mgr.killAll()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not bind a provisional PTY the user has never typed in', () => {
    const a = mgr.startNew(CWD, 'codex')
    // Past the boot fallback: boot() has written its own trailing \r straight to the pty. If that
    // write counted as a submit, this PTY would wrongly become bindable.
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([])
    expect(a.sessionId).not.toBe('s1')
  })

  it('does not treat typing without Enter as a submit', () => {
    const a = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.write(a.ptyId, 'summarize this repo')
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([])
  })

  it('binds once the user submits', () => {
    const a = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.write(a.ptyId, 'summarize this repo\r')
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([`${a.ptyId}->s1`])
    expect(mgr.findBySession('s1')?.ptyId).toBe(a.ptyId)
  })

  it('an idle tab does not steal the rollout of a tab that was used', () => {
    const idle = mgr.startNew(CWD, 'codex') // opened first, never touched
    vi.advanceTimersByTime(100)
    const used = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.write(used.ptyId, 'go\r')

    mgr.bindProvisionalCodex([cand('s1', Date.now())])

    expect(bound).toEqual([`${used.ptyId}->s1`])
    expect(mgr.findBySession('s1')?.ptyId).toBe(used.ptyId)
    expect(mgr.findBySession('s1')?.ptyId).not.toBe(idle.ptyId)
  })

  it('pairs rollouts by submit order even when it is the reverse of spawn order', () => {
    const first = mgr.startNew(CWD, 'codex') // spawned FIRST
    vi.advanceTimersByTime(100)
    const second = mgr.startNew(CWD, 'codex') // spawned SECOND
    vi.advanceTimersByTime(PAST_BOOT)

    // ...but the user submits in the second tab first.
    mgr.write(second.ptyId, 'go\r')
    const secondSubmit = Date.now()
    vi.advanceTimersByTime(5000)
    mgr.write(first.ptyId, 'go\r')
    const firstSubmit = Date.now()

    mgr.bindProvisionalCodex([
      cand('rollFromSecond', secondSubmit),
      cand('rollFromFirst', firstSubmit)
    ])

    // Keyed on spawn order these two swapped, putting each row's terminal on the other's transcript.
    expect(bound).toEqual([`${second.ptyId}->rollFromSecond`, `${first.ptyId}->rollFromFirst`])
  })

  it('leaves Claude sessions alone — their id is pre-assigned, never correlated', () => {
    const c = mgr.startNew(CWD, 'claude')
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.write(c.ptyId, 'go\r')
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([])
    expect(mgr.findBySession(c.sessionId)?.ptyId).toBe(c.ptyId)
  })

  it('ignores a rollout from a different cwd', () => {
    const a = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.write(a.ptyId, 'go\r')
    mgr.bindProvisionalCodex([cand('s1', Date.now(), '/elsewhere')])
    expect(bound).toEqual([])
  })
})
