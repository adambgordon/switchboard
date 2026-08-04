import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cover for the ORCHESTRATION around Codex identity — the seam the pure `codexIdentity` tests can't
 * reach. The resolver decides *whether* the evidence proves a binding; this decides who gets asked,
 * how often, and whether an answer that arrived late is still safe to apply.
 *
 * The retry budget and the staleness re-checks are the load-bearing parts. `lsof` runs
 * asynchronously, so a PTY can exit or be bound by an earlier in-flight answer while a probe is out —
 * and applying an identity to the wrong PTY is precisely the bug this whole design exists to prevent.
 *
 * node-pty is a native module built for Electron's ABI and cannot load under vitest, and no real
 * process is needed: what's under test is the manager's own bookkeeping. The resolver is injected for
 * the same reason — the point is to drive its answers, not to spawn `lsof`.
 */
/**
 * `pid` is a live getter over a table the test can rewrite, so "the process behind this PTY was
 * replaced" is reproducible without a test-only setter on PtyManager. Spawns are numbered in order,
 * so the first PTY of a test is index 0.
 */
const ptyPids = vi.hoisted(() => ({ table: new Map<number, number>(), spawns: 0 }))
vi.mock('node-pty', () => ({
  spawn: () => {
    const index = ptyPids.spawns++
    ptyPids.table.set(index, 1000 + index)
    // `kill()` fires the exit callback, as a real pty does — that's what makes the manager drop the
    // entry from its live map, so "the terminal is gone" is reproducible without reaching into it.
    let exited: ((e: { exitCode: number }) => void) | null = null
    return {
      get pid(): number {
        return ptyPids.table.get(index) ?? -1
      },
      write: () => {},
      resize: () => {},
      kill: () => exited?.({ exitCode: 0 }),
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exited = cb
        return { dispose: () => {} }
      }
    }
  }
}))

import { PtyManager, type CodexBindingResolver } from '../src/main/pty/manager'
import type { CodexBinding, ProvisionalPty } from '../src/main/pty/codexIdentity'

const CWD = '/repo'
const S1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const S2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

interface Call {
  provisional: ProvisionalPty[]
  eligible: string[]
}

describe('PtyManager Codex identity probing', () => {
  let mgr: PtyManager
  let bound: string[]
  let active: number
  let calls: Call[]
  /** What the injected resolver returns next. Replaced per-test. */
  let answer: (p: readonly ProvisionalPty[]) => CodexBinding[]
  /** Set to hold a probe open so overlap/staleness can be driven deterministically. */
  let gate: { promise: Promise<void>; release: () => void } | null

  const makeGate = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => {}
    const promise = new Promise<void>((res) => {
      release = () => res()
    })
    return { promise, release }
  }

  const resolver: CodexBindingResolver = async (provisional, eligible) => {
    calls.push({ provisional: [...provisional], eligible: [...eligible] })
    if (gate) await gate.promise
    return answer(provisional)
  }

  beforeEach(() => {
    ptyPids.table.clear()
    ptyPids.spawns = 0
    calls = []
    bound = []
    active = 0
    gate = null
    answer = () => []
    mgr = new PtyManager({ resolveBindings: resolver })
    mgr.on('bound', (ptyId: string, _old: string, newId: string) => bound.push(`${ptyId}->${newId}`))
    mgr.on('active-changed', () => {
      active += 1
    })
  })

  afterEach(() => {
    mgr.killAll()
  })

  // --- who gets probed ---

  it('passes the real shell pid and the eligible id set', async () => {
    const a = mgr.startNew(CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(1)
    expect(calls[0].provisional).toEqual([{ ptyId: a.ptyId, shellPid: 1000 }])
    expect(calls[0].eligible).toEqual([S1])
  })

  it('never probes for a Claude session — its id is imposed at spawn', async () => {
    mgr.startNew(CWD, 'claude')
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toEqual([])
  })

  it('never probes for a resumed Codex session — its id is already known', async () => {
    mgr.resume(S1, CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S2]))
    expect(calls).toEqual([])
  })

  it('never probes once every provisional PTY has bound', async () => {
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    calls = []
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(calls).toEqual([])
  })

  it('does not probe when no unclaimed rollout exists — the pre-first-turn window', async () => {
    mgr.startNew(CWD, 'codex')
    // Empty index, and then an index holding only a session another live PTY already drives.
    await mgr.probeCodexIdentity(new Set())
    mgr.resume(S1, CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toEqual([])
  })

  it('subtracts sessions a live PTY already owns from the candidate set', async () => {
    mgr.startNew(CWD, 'codex')
    mgr.resume(S1, CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(calls[0].eligible).toEqual([S2])
  })

  // --- the retry budget ---

  it('probes at most three times for an identical state', async () => {
    mgr.startNew(CWD, 'codex')
    for (let i = 0; i < 8; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)
  })

  it('a change to the eligible set resets the budget', async () => {
    mgr.startNew(CWD, 'codex')
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(calls).toHaveLength(6)
  })

  it('a new provisional PTY resets the budget', async () => {
    mgr.startNew(CWD, 'codex')
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)
    mgr.startNew(CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(4)
  })

  it('an unchanged state is not re-probed just because the id set was rebuilt', async () => {
    // reindexAndBroadcast hands over a freshly-built Set every pass; only its MEMBERSHIP counts, and
    // iteration order must not either, or the budget would reset on every tick and probe forever.
    mgr.startNew(CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    await mgr.probeCodexIdentity(new Set([S2, S1]))
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(calls).toHaveLength(3)
    await mgr.probeCodexIdentity(new Set([S2, S1]))
    expect(calls).toHaveLength(3)
  })

  it('keeps retrying, slowly, after the eager budget is spent — the answer can change while the inputs do not', async () => {
    // The signature is built from Switchboard's INPUTS, but the answer depends on OS state that isn't
    // in it, so "same inputs" does not mean "same answer". A hard cap would strand two real cases
    // permanently: a run of lsof timeouts inside the eager window, and a user who Ctrl-Cs a new Codex
    // terminal and types `codex resume <id>` — that rollout was ALREADY eligible at spawn, so its
    // arrival cannot change the signature and cannot reset a budget.
    const a = mgr.startNew(CWD, 'codex')
    answer = () => [] // the OS shows nothing yet
    for (let i = 0; i < 6; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3) // eager budget spent, and paced from here

    // More re-indexes at the same instant must NOT probe — the pacing has to actually pace.
    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(Date.now())
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)

    // Ten seconds later the OS can finally prove it, with the signature never having changed.
    clock.mockReturnValue(Date.now() + 10_001)
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    clock.mockRestore()

    expect(calls).toHaveLength(4)
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
  })

  it('coalesces overlapping re-indexes onto one probe without spending extra attempts', async () => {
    mgr.startNew(CWD, 'codex')
    gate = makeGate()
    const first = mgr.probeCodexIdentity(new Set([S1]))
    // Three more re-indexes land while lsof is still out.
    await mgr.probeCodexIdentity(new Set([S1]))
    await mgr.probeCodexIdentity(new Set([S1]))
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(1)
    gate.release()
    await first
    gate = null
    // Only ONE attempt was consumed, so two remain.
    await mgr.probeCodexIdentity(new Set([S1]))
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)
  })

  // --- staleness: an answer that arrives after the world moved ---

  it('skips a PTY that exited while the probe ran, without losing its peers', async () => {
    // Two terminals, one answer. A dies mid-probe; B must still bind. Asserting only "A did not bind"
    // would also be satisfied by the whole apply loop throwing and being swallowed — so B's binding is
    // what proves the missing PTY was SKIPPED rather than fatal.
    const a = mgr.startNew(CWD, 'codex')
    const b = mgr.startNew(CWD, 'codex')
    gate = makeGate()
    answer = () => [
      { ptyId: a.ptyId, sessionId: S1 },
      { ptyId: b.ptyId, sessionId: S2 }
    ]
    const p = mgr.probeCodexIdentity(new Set([S1, S2]))
    mgr.kill(a.ptyId) // the mock's kill fires onExit, so the entry really leaves the live map
    gate.release()
    await p
    expect(bound).toEqual([`${b.ptyId}->${S2}`])
    expect(mgr.findBySession(S1)).toBeNull()
  })

  it('discards a result whose PTY was replaced by a different process', async () => {
    const a = mgr.startNew(CWD, 'codex')
    gate = makeGate()
    answer = () => [{ ptyId: a.ptyId, sessionId: S1 }]
    const p = mgr.probeCodexIdentity(new Set([S1]))
    // Same ptyId, different underlying pid — the snapshot no longer describes this process, so the
    // terminal the evidence was gathered about is not the terminal we would be binding.
    ptyPids.table.set(0, 9999)
    gate.release()
    await p
    expect(bound).toEqual([])
  })

  it('binds a PTY at most once per result, even if it appears twice', async () => {
    // Only one probe is ever in flight, so a PTY cannot be bound between snapshot and apply by
    // another probe. What IS reachable is a result naming the same PTY twice; the second must be
    // rejected rather than overwrite the first binding.
    const a = mgr.startNew(CWD, 'codex')
    answer = () => [
      { ptyId: a.ptyId, sessionId: S1 },
      { ptyId: a.ptyId, sessionId: S2 }
    ]
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    expect(mgr.findBySession(S2)).toBeNull()
  })

  it('does not bind a session another live PTY took while the probe ran', async () => {
    const a = mgr.startNew(CWD, 'codex')
    gate = makeGate()
    answer = () => [{ ptyId: a.ptyId, sessionId: S1 }]
    const p = mgr.probeCodexIdentity(new Set([S1]))
    mgr.resume(S1, CWD, 'codex') // that conversation is now live elsewhere
    gate.release()
    await p
    expect(bound).toEqual([])
    expect(mgr.findBySession(S1)?.ptyId).not.toBe(a.ptyId)
  })

  it('ignores a result naming a session outside the set it was asked about', async () => {
    const a = mgr.startNew(CWD, 'codex')
    answer = () => [{ ptyId: a.ptyId, sessionId: S2 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([])
  })

  it('ignores a result naming a PTY that does not exist', async () => {
    mgr.startNew(CWD, 'codex')
    answer = () => [{ ptyId: 'not-a-real-pty', sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([])
  })

  it('ignores a result naming a LIVE PTY that was never probed', async () => {
    // Distinct from the case above, and the one the pid check actually exists for: the Claude PTY is
    // in the live map, so the existence guard passes — only the absence of a probe snapshot for it
    // stops a Claude session from being handed a Codex conversation's id.
    mgr.startNew(CWD, 'codex')
    const claude = mgr.startNew(CWD, 'claude')
    answer = () => [{ ptyId: claude.ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([])
    expect(mgr.findBySession(S1)).toBeNull()
  })

  it('a resolver that rejects leaves probing usable rather than wedged', async () => {
    // The assertion that matters is the CALL COUNT: if the throw left `probeInFlight` stuck true, the
    // second and third probes would be silently swallowed as "already in flight" and binding would be
    // dead for the rest of this PTY's life. Asserting only that the promise resolved would pass either
    // way, since a throwing resolver can never bind anything.
    let calledTimes = 0
    const boom: CodexBindingResolver = async () => {
      calledTimes += 1
      throw new Error('lsof blew up')
    }
    const m = new PtyManager({ resolveBindings: boom })
    const a = m.startNew(CWD, 'codex')
    await expect(m.probeCodexIdentity(new Set([S1]))).resolves.toBeUndefined()
    await m.probeCodexIdentity(new Set([S1]))
    await m.probeCodexIdentity(new Set([S1]))
    expect(calledTimes).toBe(3)
    expect(m.findBySession(a.sessionId)?.ptyId).toBe(a.ptyId)
    m.killAll()
  })

  // --- the successful bind contract ---

  it('emits bound then active-changed, and rekeys the session lookup', async () => {
    const a = mgr.startNew(CWD, 'codex')
    const before = active
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    expect(active).toBeGreaterThan(before)
    expect(mgr.findBySession(S1)?.ptyId).toBe(a.ptyId)
    expect(mgr.findBySession(a.sessionId)).toBeNull()
    expect(mgr.findBySession(S1)?.provisional).toBe(false)
  })

  it('binds several terminals from one probe', async () => {
    const a = mgr.startNew(CWD, 'codex')
    const b = mgr.startNew(CWD, 'codex')
    answer = (p) => [
      { ptyId: p[0].ptyId, sessionId: S1 },
      { ptyId: p[1].ptyId, sessionId: S2 }
    ]
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(bound.sort()).toEqual([`${a.ptyId}->${S1}`, `${b.ptyId}->${S2}`].sort())
  })

  it('reports a provisional PTY as provisional over IPC until it binds', async () => {
    // The renderer cannot infer this: it must be told, or it would present a placeholder id as if it
    // were a real conversation.
    const a = mgr.startNew(CWD, 'codex')
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.provisional).toBe(true)
    expect(mgr.startNew(CWD, 'claude').provisional).toBe(false)
    expect(mgr.resume(S2, CWD, 'codex').provisional).toBe(false)
    answer = () => [{ ptyId: a.ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.provisional).toBe(false)
  })

  it('an unbindable PTY stays provisional and usable — the fail-closed state', async () => {
    const a = mgr.startNew(CWD, 'codex')
    answer = () => [] // ambiguous or unobservable: the resolver proves nothing
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([])
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.provisional).toBe(true)
    expect(mgr.findBySession(a.sessionId)?.ptyId).toBe(a.ptyId)
    // ...and the terminal still takes input.
    expect(() => mgr.write(a.ptyId, 'still works\r')).not.toThrow()
  })

  // --- write() carries no identity bookkeeping ---

  it('write() is a transparent passthrough', async () => {
    // Four timing heuristics inspected keystrokes here; every one was defeated by a real
    // counterexample (a bracketed paste's rewritten newlines, an Enter on an empty composer, a first
    // turn processed late). Nothing typed may influence identity now — including a bare Enter.
    const a = mgr.startNew(CWD, 'codex')
    mgr.write(a.ptyId, '\r')
    mgr.write(a.ptyId, '\x1b[200~pasted\rlines\x1b[201~')
    mgr.write(a.ptyId, 'typed')
    mgr.write(a.ptyId, '\r')
    await mgr.probeCodexIdentity(new Set([S1]))
    // The probe inputs are identical to the never-touched case: no submit state exists to leak in.
    expect(calls[0]).toEqual({ provisional: [{ ptyId: a.ptyId, shellPid: 1000 }], eligible: [S1] })
    expect(bound).toEqual([])
  })

  it('write() to an unknown ptyId is a no-op', () => {
    expect(() => mgr.write('nope', 'data')).not.toThrow()
  })
})
