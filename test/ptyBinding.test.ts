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

  /**
   * Type a prompt and press Enter the way xterm actually delivers it: `onData` fires per keystroke,
   * so the Enter is always its own payload — never batched onto the text before it.
   */
  const submit = (ptyId: string, text = 'go'): void => {
    mgr.write(ptyId, text)
    mgr.write(ptyId, '\r')
  }

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
    submit(a.ptyId, 'summarize this repo')
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([`${a.ptyId}->s1`])
    expect(mgr.findBySession('s1')?.ptyId).toBe(a.ptyId)
  })

  it('an idle tab does not steal the rollout of a tab that was used', () => {
    const idle = mgr.startNew(CWD, 'codex') // opened first, never touched
    vi.advanceTimersByTime(100)
    const used = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    submit(used.ptyId)

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
    submit(second.ptyId)
    const secondSubmit = Date.now()
    vi.advanceTimersByTime(5000)
    submit(first.ptyId)
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
    submit(c.ptyId)
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([])
    expect(mgr.findBySession(c.sessionId)?.ptyId).toBe(c.ptyId)
  })

  it('a bracketed multi-line paste is not a submit', () => {
    // xterm normalizes every newline in a multi-line paste to \r and wraps it in bracketed-paste
    // markers before term.onData forwards it here — so "contains \r" would call this a submit even
    // though the user is still composing and no rollout results.
    const pasted = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(100)
    const typed = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)

    mgr.write(pasted.ptyId, '\x1b[200~first line\rsecond line\x1b[201~')
    vi.advanceTimersByTime(1000)
    submit(typed.ptyId) // the only real submit

    mgr.bindProvisionalCodex([cand('s1', Date.now())])

    expect(bound).toEqual([`${typed.ptyId}->s1`])
  })

  it('a paste split across chunks does not leak a submit from its inner newline', () => {
    const pasted = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(100)
    const typed = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)

    mgr.write(pasted.ptyId, '\x1b[200~first line')
    mgr.write(pasted.ptyId, '\rsecond line') // still inside the paste
    mgr.write(pasted.ptyId, '\x1b[201~')
    vi.advanceTimersByTime(1000)
    submit(typed.ptyId)

    mgr.bindProvisionalCodex([cand('s1', Date.now())])

    expect(bound).toEqual([`${typed.ptyId}->s1`])
  })

  it('an Enter typed before the agent boots is not a submit', () => {
    // The pre-boot window is real — CLEAR_LINE in bootCommand.ts exists because keystrokes land at
    // the bare shell prompt before the agent command is typed. Such an Enter creates no rollout.
    const early = mgr.startNew(CWD, 'codex')
    mgr.write(early.ptyId, '\r') // at the shell prompt, before boot
    vi.advanceTimersByTime(100)
    const real = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    submit(real.ptyId)

    mgr.bindProvisionalCodex([cand('s1', Date.now())])

    expect(bound).toEqual([`${real.ptyId}->s1`])
  })

  it('still binds a submit that follows a completed paste', () => {
    // The tightened rule must not lose the ordinary case: paste a prompt, then press Enter.
    const a = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.write(a.ptyId, '\x1b[200~a pasted prompt\x1b[201~')
    mgr.write(a.ptyId, '\r')
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([`${a.ptyId}->s1`])
  })

  it('an Enter that produced no turn does not steal the other tab rollout', () => {
    // Tab 1 hits Enter on an empty composer: a real submit that Codex never turns into a rollout,
    // because firstActivityAt is only set for a non-empty message. Tab 2 then sends a real prompt.
    const empty = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(100)
    const real = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)

    mgr.write(empty.ptyId, '\r') // empty prompt — no rollout will ever exist for this
    vi.advanceTimersByTime(60_000)
    submit(real.ptyId)

    mgr.bindProvisionalCodex([cand('sReal', Date.now())])

    expect(bound).toEqual([`${real.ptyId}->sReal`])
    expect(mgr.findBySession('sReal')?.ptyId).not.toBe(empty.ptyId)
  })

  it('an Enter during the agent launch window does not mis-anchor the PTY', () => {
    // `booted` flips when the boot command is TYPED, so there is a window where the shell is still
    // exec-ing codex and it has not read stdin. An Enter there is recorded, but the real prompt comes
    // later — the PTY must still bind its own rollout rather than being stranded on the stray one.
    const a = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    mgr.write(a.ptyId, '\r') // during launch: nothing is listening yet
    // Comfortably past BIND_MAX_LAG_MS, so the stray keystroke cannot explain this rollout and only
    // keeping the later submit as well can bind it. (30_000 exactly would sit ON the bound and pass
    // for the wrong reason.)
    vi.advanceTimersByTime(45_000)
    submit(a.ptyId) // the real first prompt
    const realSubmit = Date.now()

    mgr.bindProvisionalCodex([cand('s1', realSubmit)])

    expect(bound).toEqual([`${a.ptyId}->s1`])
  })

  it('does not track submits once bound, so later Enters cannot re-bind', () => {
    const a = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    submit(a.ptyId)
    mgr.bindProvisionalCodex([cand('s1', Date.now())])
    expect(bound).toEqual([`${a.ptyId}->s1`])

    // Answering an approval prompt with Enter, long after the bind.
    vi.advanceTimersByTime(60_000)
    submit(a.ptyId)
    mgr.bindProvisionalCodex([cand('s2', Date.now())])

    expect(bound).toEqual([`${a.ptyId}->s1`])
    expect(mgr.findBySession('s2')).toBeNull()
  })

  it('ignores a rollout from a different cwd', () => {
    const a = mgr.startNew(CWD, 'codex')
    vi.advanceTimersByTime(PAST_BOOT)
    submit(a.ptyId)
    mgr.bindProvisionalCodex([cand('s1', Date.now(), '/elsewhere')])
    expect(bound).toEqual([])
  })
})
