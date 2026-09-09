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
const ptyPids = vi.hoisted(() => ({
  table: new Map<number, number>(),
  sizes: new Map<number, { cols: number; rows: number }>(),
  resizes: [] as Array<{ index: number; cols: number; rows: number }>,
  flows: [] as Array<{ index: number; action: 'pause' | 'resume' }>,
  spawns: 0,
  /** Each PTY's onData callback, by spawn index — lets a test push real terminal output so runtime
   *  state (an OSC input-request timestamp) can be SET before asserting that a correction clears it.
   *  Without this the assertion would pass against a no-op, since the field starts null. */
  feeds: [] as ((data: string) => void)[]
}))
vi.mock('node-pty', () => ({
  spawn: () => {
    const index = ptyPids.spawns++
    ptyPids.table.set(index, 1000 + index)
    ptyPids.sizes.set(index, { cols: 80, rows: 30 })
    // `kill()` fires the exit callback, as a real pty does — that's what makes the manager drop the
    // entry from its live map, so "the terminal is gone" is reproducible without reaching into it.
    let exited: ((e: { exitCode: number }) => void) | null = null
    return {
      get pid(): number {
        return ptyPids.table.get(index) ?? -1
      },
      get cols(): number {
        return ptyPids.sizes.get(index)?.cols ?? 0
      },
      get rows(): number {
        return ptyPids.sizes.get(index)?.rows ?? 0
      },
      write: () => {},
      resize: (cols: number, rows: number) => {
        ptyPids.sizes.set(index, { cols, rows })
        ptyPids.resizes.push({ index, cols, rows })
      },
      kill: () => exited?.({ exitCode: 0 }),
      pause: () => ptyPids.flows.push({ index, action: 'pause' }),
      resume: () => ptyPids.flows.push({ index, action: 'resume' }),
      onData: (cb: (data: string) => void) => {
        ptyPids.feeds[index] = cb
        return { dispose: () => {} }
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exited = cb
        return { dispose: () => {} }
      }
    }
  }
}))

import { PtyManager, type CodexBindingResolver } from '../src/main/pty/manager'
import type { CodexBinding, CodexPtyTarget } from '../src/main/pty/codexIdentity'

const CWD = '/repo'
const S1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const S2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'

interface Call {
  targets: CodexPtyTarget[]
  eligible: string[]
}

describe('PtyManager Codex identity probing', () => {
  let mgr: PtyManager
  let bound: string[]
  /** The `kind` of each emitted bind, in order — the renderer branches on it destructively. */
  let kinds: string[]
  /**
   * Both event names in ONE sequence, because their relative order is itself a contract: the
   * renderer uses `bound` to keep a Live row in its slot before `active-changed` delivers the new
   * sessionId, and the order sync would otherwise read the same terminal as newly live and prepend
   * it. Recorded in separate arrays this was untestable — swapping the two emissions left all 572
   * tests green.
   */
  let events: string[]
  let active: number
  let calls: Call[]
  /** What the injected resolver returns next. Replaced per-test. */
  let answer: (p: readonly CodexPtyTarget[]) => CodexBinding[]
  /** Set to hold a probe open so overlap/staleness can be driven deterministically. */
  let gate: { promise: Promise<void>; release: () => void } | null

  const makeGate = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => {}
    const promise = new Promise<void>((res) => {
      release = () => res()
    })
    return { promise, release }
  }

  const resolver: CodexBindingResolver = async (targets, eligible) => {
    calls.push({ targets: [...targets], eligible: [...eligible] })
    if (gate) await gate.promise
    return answer(targets)
  }

  beforeEach(() => {
    ptyPids.table.clear()
    ptyPids.sizes.clear()
    ptyPids.resizes = []
    ptyPids.flows = []
    ptyPids.spawns = 0
    ptyPids.feeds = []
    calls = []
    bound = []
    kinds = []
    events = []
    active = 0
    gate = null
    answer = () => []
    mgr = new PtyManager({ resolveBindings: resolver })
    mgr.on('bound', (ptyId: string, _old: string, newId: string, kind: string) => {
      bound.push(`${ptyId}->${newId}`)
      kinds.push(kind)
      events.push('bound')
    })
    mgr.on('active-changed', () => {
      active += 1
      events.push('active')
    })
  })

  afterEach(() => {
    mgr.killAll()
  })

  it('assigns spawn ownership before announcing the active set', () => {
    events = []
    mgr.startNew(CWD, 'claude', () => events.push('owner'))
    expect(events).toEqual(['owner', 'active'])
  })

  describe('repaint', () => {
    it('nudges a sized PTY one column and restores its exact geometry', () => {
      const live = mgr.startNew(CWD, 'claude')
      mgr.resize(live.ptyId, 100, 40)
      ptyPids.resizes = []

      mgr.repaint(live.ptyId)

      expect(ptyPids.resizes).toEqual([
        { index: 0, cols: 101, rows: 40 },
        { index: 0, cols: 100, rows: 40 }
      ])
    })

    it('does not size or boot a PTY that no renderer has measured yet', () => {
      const live = mgr.startNew(CWD, 'claude')
      mgr.repaint(live.ptyId)
      expect(ptyPids.resizes).toEqual([])
    })
  })

  describe('output flow control', () => {
    it('resumes only after every independent pause reason clears', () => {
      const live = mgr.startNew(CWD, 'claude')
      mgr.setOutputPaused(live.ptyId, 'renderer:1', true)
      mgr.setOutputPaused(live.ptyId, 'transfer:1', true)
      mgr.setOutputPaused(live.ptyId, 'transfer:1', false)
      expect(ptyPids.flows).toEqual([{ index: 0, action: 'pause' }])
      mgr.setOutputPaused(live.ptyId, 'renderer:1', false)
      expect(ptyPids.flows).toEqual([
        { index: 0, action: 'pause' },
        { index: 0, action: 'resume' }
      ])
    })

    it('releases a renderer pause when its window disappears', () => {
      const live = mgr.startNew(CWD, 'claude')
      mgr.setOutputPaused(live.ptyId, 'renderer:7', true)
      mgr.releaseOutputPause('renderer:7')
      expect(ptyPids.flows).toEqual([
        { index: 0, action: 'pause' },
        { index: 0, action: 'resume' }
      ])
    })
  })

  // --- who gets probed ---

  it('passes the real shell pid and the eligible id set', async () => {
    const a = mgr.startNew(CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(1)
    expect(calls[0].targets).toEqual([{ ptyId: a.ptyId, shellPid: 1000 }])
    expect(calls[0].eligible).toEqual([S1])
  })

  it('never probes for a Claude session — its id is imposed at spawn', async () => {
    mgr.startNew(CWD, 'claude')
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toEqual([])
  })

  it('probes a resumed Codex session too — a clicked id is asserted, never observed', async () => {
    // The click supplies a real conversation id, so the PTY is not provisional. That is not the same
    // as knowing: `codex resume` can fail, or be Ctrl-C'd and replaced by something else entirely, and
    // nothing would ever notice. Asserted identity still has to be checked against the OS.
    const a = mgr.resume(S1, CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(calls).toHaveLength(1)
    expect(calls[0].targets).toEqual([{ ptyId: a.ptyId, shellPid: 1000 }])
  })

  it('keeps probing after a PTY has bound — identity is maintained, not just established', async () => {
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    calls = []
    // A conversation appears that no terminal owns. That is the signal a bound terminal may have moved
    // on to it, so the bound terminal must be re-examined rather than trusted forever.
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(calls).toHaveLength(1)
    expect(calls[0].targets).toEqual([{ ptyId: a.ptyId, shellPid: 1000 }])
  })

  it('does not probe when no rollout exists at all', async () => {
    mgr.startNew(CWD, 'codex')
    await mgr.probeCodexIdentity(new Set())
    expect(calls).toEqual([])
  })

  it("keeps a live PTY's own conversation in the candidate set", async () => {
    // Load-bearing, and the opposite of what this did before. The resolver refuses to answer for a
    // terminal holding two eligible rollouts, because Codex really does hold several open at once and
    // picking one would be a guess. Subtracting the id a terminal already owns hides one side of that
    // pair, so a settled, correct terminal holding its own rollout plus one other would look like it
    // holds a single unambiguous OTHER rollout — and get corrected onto it. Keeping the set whole is
    // what preserves the ambiguity. Nothing is lost: `bindCodex` still refuses an id another live PTY
    // owns, and the resolver still refuses a conversation open on two terminals.
    mgr.startNew(CWD, 'codex')
    mgr.resume(S1, CWD, 'codex')
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect([...calls[0].eligible].sort()).toEqual([S1, S2].sort())
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
    events = [] // drop the spawn's own active-changed so the assertion is about this bind
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    expect(active).toBeGreaterThan(before)
    // The ORDER, not just the occurrence. `bound` must land first so the renderer can keep the Live
    // row in its slot before the new sessionId arrives in the active list; reversed, the order sync
    // sees an unknown id, calls it newly live, and prepends the row it was supposed to leave alone.
    expect(events).toEqual(['bound', 'active'])
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

  // --- correcting an identity that has drifted ---

  it('corrects a terminal that has moved to a different conversation', async () => {
    // A Switchboard terminal is a real login shell, so it outlives the Codex process
    // it was bound against: quit Codex, `cd`, start it again, and the terminal is running a different
    // conversation while the row still names the old one — Terminal showing one thing, title and
    // Formatted another, and the real conversation sitting in Recent as if nobody were running it.
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])

    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S2 }]
    events = []
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    // Same ordering contract on the correction path — this is the path the Live-slot retarget rides.
    expect(events).toEqual(['bound', 'active'])
    expect(bound).toEqual([`${a.ptyId}->${S1}`, `${a.ptyId}->${S2}`])
    expect(mgr.findBySession(S2)?.ptyId).toBe(a.ptyId)
    expect(mgr.findBySession(S1)).toBeNull()
    // The discriminator the renderer branches on. The first swap replaced a throwaway placeholder,
    // so migrating everything keyed to it is right; the second moved between two REAL conversations,
    // where the same migration would delete S1's read state and overwrite S2's. Emitting `initial`
    // for both — which is what a missing discriminator amounts to — is the corrupting case.
    expect(kinds).toEqual(['initial', 'correction'])
  })

  it('labels a resumed terminal being corrected as a correction, not an initial bind', async () => {
    // A resumed PTY is not provisional, so its id is real from the start; if `codex resume` did not
    // land on it, the swap that follows is a correction even though this PTY never bound before.
    const a = mgr.resume(S1, CWD, 'codex')
    answer = () => [{ ptyId: a.ptyId, sessionId: S2 }]
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(bound).toEqual([`${a.ptyId}->${S2}`])
    expect(kinds).toEqual(['correction'])
  })

  it('a correction drops the old conversation approval request', async () => {
    // `inputRequestedAt` outranks transcript-derived liveness, so carrying it across a correction
    // makes the row pulse `asking` for an approval belonging to the conversation the terminal left —
    // and ordinary TUI output cannot clear it. The OSC sequence is pushed through the REAL scanner
    // first, so the assertion has something to clear; asserting on a field that was never set would
    // pass against a no-op.
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    ptyPids.feeds[0]('\x1b]9;Approval requested: run rm -rf /tmp/x\x07')
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.inputRequestedAt).not.toBeNull()

    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S2 }]
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(mgr.findBySession(S2)?.ptyId).toBe(a.ptyId)
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.inputRequestedAt).toBeNull()
  })

  it('a correction drops a half-written sequence so it cannot splice onto the next process', async () => {
    // The scanner buffers an incomplete OSC 9 across chunk boundaries. If the process writing one is
    // killed before the terminator — Ctrl-C mid-notification — the fragment waits for a terminator
    // that the NEXT process now supplies, and `Approval requested: …` from the dead conversation gets
    // completed by ordinary output from the new one.
    //
    // The follow-up chunk is a BARE BEL in plain text, deliberately: the scanner already restarts
    // parsing when a new OSC 9 START appears before a terminator, so a fixture whose second chunk
    // opens another OSC 9 exercises that existing guard instead of this one and proves nothing. A
    // lone bell — which terminals emit routinely — supplies the missing terminator with no new start
    // to trigger the restart, splicing `Approval requested: …` onto whatever followed it.
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    ptyPids.feeds[0]('\x1b]9;Approval requested: delete everything') // no terminator — writer died
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.inputRequestedAt).toBeNull()

    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S2 }]
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    ptyPids.feeds[0]('compiling\x07') // the new process, saying something harmless, with a bell
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.inputRequestedAt).toBeNull()
  })

  it('an initial bind keeps an approval request — it belongs to the id being named', async () => {
    // The other direction: on a placeholder bind the notification came from the very process whose
    // rollout is being named, so clearing it would drop a real "waiting on you" signal.
    const a = mgr.startNew(CWD, 'codex')
    ptyPids.feeds[0]('\x1b]9;Approval requested: apply patch\x07')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.inputRequestedAt).not.toBeNull()
  })

  it('a terminal proven to be running what the row already says announces nothing', async () => {
    // Confirmation is not a state change: re-emitting `bound` every time the answer agrees would churn
    // the renderer's rekey and the active broadcast twice a second for no reason.
    const a = mgr.resume(S1, CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    const before = active
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([])
    expect(active).toBe(before)
    expect(mgr.findBySession(S1)?.ptyId).toBe(a.ptyId)
  })

  it('refuses to correct a terminal onto a conversation another terminal is running', async () => {
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    const b = mgr.resume(S2, CWD, 'codex')
    answer = () => [{ ptyId: a.ptyId, sessionId: S2 }] // contradicts B, which already drives S2
    await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(mgr.findBySession(S2)?.ptyId).toBe(b.ptyId)
    expect(mgr.findBySession(S1)?.ptyId).toBe(a.ptyId)
  })

  it('an empty answer never un-binds a terminal', async () => {
    // Absence of evidence is not evidence of drift: it is also what an lsof timeout, a tmux wrapper, or
    // Codex simply not running right now looks like. Correcting on positive proof is safe; reverting a
    // row to "terminal only" because a probe came back quiet would flap constantly.
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    answer = () => []
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1, S2]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    expect(mgr.findBySession(S1)?.ptyId).toBe(a.ptyId)
    expect(mgr.list().find((s) => s.ptyId === a.ptyId)?.provisional).toBe(false)
  })

  // --- what re-validation costs when nothing is wrong ---

  it('stops probing once every terminal is confirmed and nothing has changed', async () => {
    // The whole cost argument. Probing every live Codex terminal forever would mean an lsof every ten
    // seconds for the life of every session; instead a proven terminal goes quiet, and only a change to
    // the observed state wakes it.
    mgr.resume(S1, CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    for (let i = 0; i < 3; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3) // the eager budget for this state, then proven

    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(Date.now() + 600_000) // far past any pacing interval
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1]))
    clock.mockRestore()
    expect(calls).toHaveLength(3)
  })

  it('a terminal proven by binding goes quiet too, not only one proven by agreement', async () => {
    // Confirmation is recorded in two places — agreeing with the current id, and being corrected onto a
    // new one. Covering only the first would let the second keep an already-proven terminal on the
    // paced retry for the rest of its life.
    mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    for (let i = 0; i < 3; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)

    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(Date.now() + 600_000)
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1]))
    clock.mockRestore()
    expect(calls).toHaveLength(3)
  })

  it('a bind is itself proof — later silence does not restart the retry', async () => {
    // Isolates the confirmation recorded by binding, which the test above cannot: there, a second probe
    // agrees with the freshly-bound id and confirms it anyway, so the bind's own record is redundant
    // and its removal goes unnoticed. Here the evidence disappears right after the bind — Codex closed
    // the rollout, lsof got flaky — and only the bind itself can account for the terminal being proven.
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`])
    answer = () => []
    await mgr.probeCodexIdentity(new Set([S1]))
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)

    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(Date.now() + 600_000)
    for (let i = 0; i < 5; i++) await mgr.probeCodexIdentity(new Set([S1]))
    clock.mockRestore()
    expect(calls).toHaveLength(3)
  })

  it('tells the re-index path that a bound Codex terminal still needs probing', async () => {
    // The gate `reindexAndBroadcast` actually calls. Every behavior above reaches probeCodexIdentity
    // directly, so if this narrowed back to provisional-only the entire re-validation path would be
    // dead in the shipped app while the whole suite stayed green.
    expect(mgr.hasCodexToProbe()).toBe(false)
    mgr.startNew(CWD, 'claude')
    expect(mgr.hasCodexToProbe()).toBe(false)
    const a = mgr.startNew(CWD, 'codex')
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    expect(bound).toEqual([`${a.ptyId}->${S1}`]) // no longer provisional...
    expect(mgr.hasCodexToProbe()).toBe(true) // ...and still worth asking about
    mgr.kill(a.ptyId)
    expect(mgr.hasCodexToProbe()).toBe(false)
  })

  it('a resumed terminal keeps being asked about until the OS can actually see it', async () => {
    // The dead zone the confirmation rule has to avoid. Codex takes longer to boot and open its rollout
    // than the eager burst lasts (three re-indexes, ~1.5s), so a resumed terminal's first probes find
    // nothing. Without the paced retry for unproven terminals it would never be verified at all — and
    // its own conversation is already indexed, so no signature change would ever come to rescue it.
    mgr.resume(S1, CWD, 'codex')
    answer = () => []
    for (let i = 0; i < 6; i++) await mgr.probeCodexIdentity(new Set([S1]))
    expect(calls).toHaveLength(3)

    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(Date.now() + 10_001)
    answer = (p) => [{ ptyId: p[0].ptyId, sessionId: S1 }]
    await mgr.probeCodexIdentity(new Set([S1]))
    clock.mockRestore()
    expect(calls).toHaveLength(4)
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
    expect(calls[0]).toEqual({ targets: [{ ptyId: a.ptyId, shellPid: 1000 }], eligible: [S1] })
    expect(bound).toEqual([])
  })

  it('write() to an unknown ptyId is a no-op', () => {
    expect(() => mgr.write('nope', 'data')).not.toThrow()
  })
})
