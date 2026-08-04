import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseLsof,
  resolveBindings,
  resolveCodexBindings,
  type LsofProcess
} from '../src/main/pty/codexIdentity'

/**
 * Cover for OS-backed Codex identity. The rules are deliberately unforgiving, so most of this file is
 * the NO-BIND matrix: every shape of missing, duplicated, or contradictory evidence must produce zero
 * bindings rather than a plausible guess. Four timing heuristics were shipped and rolled back before
 * this design, each defeated by one counterexample, so the ambiguity cases are the point — not the
 * happy path.
 *
 * `REAL_CAPTURE` is verbatim `lsof -n -p <shell> -c codex -F0pcfn` output from a live Codex session
 * (lsof 4.91, macOS), trimmed to the load-bearing records with their real ordering, fd numbers, and
 * name oddities intact. Everything else is built by `lsofText` so a rule can be isolated.
 *
 * The `resolveCodexBindings` block runs the REAL exec path against stub binaries, because the branches
 * that decide whether output is trustworthy are the ones that prevent a wrong bind — and they can only
 * be exercised by a process that actually exits nonzero, or actually gets killed mid-write.
 */

/** Session ids are real UUIDs because `rolloutSessionId` requires UUID shape. */
const S1 = '019fcd61-1ab4-72f3-9ebd-c81db6806593'
const S2 = '019fcd62-2b25-83e4-8fdc-d92ec7917604'
const SUB = '019fcd63-3c36-94f5-9aed-ea3fd8a28715'

/** Passed explicitly everywhere, so nothing depends on the running user's home directory. */
const ROOT = '/Users/dev/.codex/sessions'

const rollout = (id: string, day = '2026/08/04'): string =>
  `${ROOT}/${day}/rollout-2026-08-04T11-25-20-${id}.jsonl`

/**
 * Verbatim capture. Note what a real `-p <shellPid> -c codex` probe does and does not contain: the
 * shell (via -p), the real `codex` process and the `codex-code-mode-host` helper (both via the -c
 * PREFIX match) — but NOT the intermediate `node` wrapper, which neither selector matches. The
 * helper's fd 0 is a socket while it holds the terminal on fd 31, which is precisely why only fd 0
 * may be read as "owns this terminal".
 */
const REAL_CAPTURE =
  [
    'p2202\0czsh\0',
    'f0\0n/dev/ttys001\0',
    'f1\0n/dev/ttys001\0',
    'f2\0n/dev/ttys001\0',
    'f10\0n/\0',
    'f11\0n->0x6e8f705458ecd399\0',
    'p2218\0ccodex\0',
    'f0\0n/dev/ttys001\0',
    'f1\0n/dev/ttys001\0',
    'f2\0n/dev/null\0',
    'f10\0n/Users/dev/.codex/state_5.sqlite\0',
    'f26\0ncount=0, state=0xa\0',
    'f28\0n->0x3602b09ccabd255c\0',
    'f31\0n/dev/ttys001\0',
    `f38\0n${rollout(S1)}\0`,
    'p2775\0ccodex-code-mode-host\0',
    'f0\0n->0x260cb853656b5efc\0',
    'f31\0n/dev/ttys001\0'
  ].join('\n') + '\n'

interface Spec {
  pid: number
  command: string
  files: [string, string][]
}

/** Build `-F0pcfn` text: newline-separated sets of NUL-TERMINATED fields. */
function lsofText(specs: Spec[]): string {
  const lines: string[] = []
  for (const s of specs) {
    lines.push(`p${s.pid}\0c${s.command}\0`)
    for (const [fd, name] of s.files) lines.push(`f${fd}\0n${name}\0`)
  }
  return lines.join('\n') + '\n'
}

/** A shell owning `tty`, plus a codex process on that same tty holding `ids` open. */
function terminal(shellPid: number, tty: string, ids: string[]): Spec[] {
  return [
    { pid: shellPid, command: 'zsh', files: [['0', tty], ['1', tty], ['2', tty]] },
    {
      pid: shellPid + 1,
      command: 'codex',
      files: [['0', tty], ['1', tty], ...ids.map((id, i): [string, string] => [`${38 + i}`, rollout(id)])]
    }
  ]
}

const parseOf = (specs: Spec[]): LsofProcess[] => parseLsof(lsofText(specs))
/** Always pins the sessions root, so a rollout path is judged against a fixed tree. */
const resolve = (
  procs: readonly LsofProcess[],
  prov: { ptyId: string; shellPid: number }[],
  eligible: Set<string>
) => resolveBindings(procs, prov, eligible, ROOT)

describe('parseLsof', () => {
  it('parses the real capture into processes and their files', () => {
    const procs = parseLsof(REAL_CAPTURE)
    expect(procs.map((p) => [p.pid, p.command])).toEqual([
      [2202, 'zsh'],
      [2218, 'codex'],
      [2775, 'codex-code-mode-host']
    ])
    expect(procs[0].files).toContainEqual({ fd: '0', name: '/dev/ttys001' })
    expect(procs[1].files).toContainEqual({ fd: '38', name: rollout(S1) })
    // Names are not always paths: a bare slash, socket arrows, and a kqueue string containing a
    // comma AND a space all appear in real output and must survive parsing intact.
    expect(procs[0].files).toContainEqual({ fd: '10', name: '/' })
    expect(procs[1].files).toContainEqual({ fd: '26', name: 'count=0, state=0xa' })
    expect(procs[2].files).toContainEqual({ fd: '0', name: '->0x260cb853656b5efc' })
  })

  it('ignores file records that precede any process header', () => {
    expect(parseLsof('f0\0n/dev/ttys001\0\n')).toEqual([])
  })

  it('merges a pid that appears more than once rather than dropping records', () => {
    const procs = parseLsof(
      ['p10\0czsh\0', 'f0\0n/dev/ttys001\0', 'p10\0czsh\0', 'f9\0n/x\0'].join('\n') + '\n'
    )
    expect(procs).toHaveLength(1)
    expect(procs[0].files).toHaveLength(2)
  })

  it('keeps a file carried inline on a process line', () => {
    // Real lsof puts p/c on their own line, so this is defensive — but dropping the record would be
    // the DE-POISONING direction: it can turn a terminal holding two rollouts into one holding a
    // single, apparently exact one. Losing evidence is the dangerous way to be wrong here.
    const procs = parseLsof(`p10\0ccodex\0f38\0n${rollout(S1)}\0\n`)
    expect(procs).toEqual([
      { pid: 10, command: 'codex', files: [{ fd: '38', name: rollout(S1) }] }
    ])
  })

  it('survives truncated, empty, and garbage input without throwing', () => {
    expect(parseLsof('')).toEqual([])
    expect(parseLsof('p2202')).toEqual([{ pid: 2202, command: '', files: [] }])
    expect(parseLsof('\0\0\n\n')).toEqual([])
    expect(parseLsof('pNOTANUMBER\0czsh\0\nf0\0n/dev/ttys001\0\n')).toEqual([])
    expect(parseLsof('p-1\0czsh\0\n')).toEqual([])
    // `Number()` would accept these as pids; a digits-only test must not.
    expect(parseLsof('p0x10\0czsh\0\n')).toEqual([])
    expect(parseLsof('p1e3\0czsh\0\n')).toEqual([])
  })
})

describe('resolveBindings — exact evidence binds', () => {
  it('binds the real capture: one shell, one terminal, one open eligible rollout', () => {
    expect(resolve(parseLsof(REAL_CAPTURE), [{ ptyId: 'A', shellPid: 2202 }], new Set([S1]))).toEqual([
      { ptyId: 'A', sessionId: S1 }
    ])
  })

  it('binds several terminals in one probe', () => {
    const procs = parseOf([...terminal(100, '/dev/ttys001', [S1]), ...terminal(200, '/dev/ttys002', [S2])])
    expect(
      resolve(
        procs,
        [
          { ptyId: 'A', shellPid: 100 },
          { ptyId: 'B', shellPid: 200 }
        ],
        new Set([S1, S2])
      )
    ).toEqual([
      { ptyId: 'A', sessionId: S1 },
      { ptyId: 'B', sessionId: S2 }
    ])
  })

  it('is immune to use order — the case every timing heuristic got wrong', () => {
    // Terminal A was created first but its rollout is the NEWER one, because the user typed in B
    // first. Timing/order matching swapped these two; open-file evidence cannot, since there is no
    // ordering input at all. Proven by feeding the pairs in the opposite order and getting the same
    // answer, keyed by pid rather than position.
    const procs = parseOf([...terminal(100, '/dev/ttys001', [S2]), ...terminal(200, '/dev/ttys002', [S1])])
    const eligible = new Set([S1, S2])
    const forward = resolve(
      procs,
      [
        { ptyId: 'A', shellPid: 100 },
        { ptyId: 'B', shellPid: 200 }
      ],
      eligible
    )
    const reversed = resolve(
      [...procs].reverse(),
      [
        { ptyId: 'B', shellPid: 200 },
        { ptyId: 'A', shellPid: 100 }
      ],
      eligible
    )
    expect(forward).toEqual([
      { ptyId: 'A', sessionId: S2 },
      { ptyId: 'B', sessionId: S1 }
    ])
    expect(reversed).toEqual(forward)
  })

  it('binds the top-level rollout while Codex also holds subagent rollouts open', () => {
    // Observed in reality: one Codex process had its own rollout plus three subagent rollouts open.
    // Subagent threads are dropped by the indexer, so they never reach the eligible set — which is
    // what keeps this unambiguous rather than a four-way tie.
    const procs = parseOf(terminal(100, '/dev/ttys001', [S1, SUB]))
    expect(resolve(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))).toEqual([
      { ptyId: 'A', sessionId: S1 }
    ])
  })

  it('ignores a rollout a non-Codex process on the same terminal holds open', () => {
    // A `tail -f` / editor / grep on the rollout sits on the very same terminal as Codex, so without
    // the command gate its file would be collected too — turning an exact terminal into a contested
    // one. Codex's own open file is the evidence; another process reading a DIFFERENT conversation is
    // not a conflict, it's noise.
    const procs = parseOf([
      ...terminal(100, '/dev/ttys001', [S1]),
      { pid: 150, command: 'tail', files: [['0', '/dev/ttys001'], ['3', rollout(S2)]] }
    ])
    expect(resolve(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1, S2]))).toEqual([
      { ptyId: 'A', sessionId: S1 }
    ])
  })

  it('binds while unrelated processes and files surround the evidence', () => {
    const procs = parseOf([
      { pid: 5, command: 'Google Chrome', files: [['0', '/dev/null'], ['7', rollout(S2)]] },
      ...terminal(100, '/dev/ttys001', [S1]),
      { pid: 900, command: 'zsh', files: [['0', '/dev/ttys009']] }
    ])
    // S2 is only held by a NON-codex process, so it contributes nothing even though it is eligible.
    expect(resolve(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1, S2]))).toEqual([
      { ptyId: 'A', sessionId: S1 }
    ])
  })

  it('is unaffected by a foreign Codex running an unrelated conversation elsewhere', () => {
    // A Codex the user started in their own Terminal.app, on another tty, holding another eligible
    // rollout. It must neither be stolen by our provisional PTY nor poison it.
    const procs = parseOf([
      ...terminal(100, '/dev/ttys001', [S1]),
      ...terminal(500, '/dev/ttys007', [S2])
    ])
    expect(resolve(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1, S2]))).toEqual([
      { ptyId: 'A', sessionId: S1 }
    ])
  })
})

describe('resolveBindings — ambiguity and absence bind nothing', () => {
  const noBind = (
    procs: LsofProcess[],
    prov: { ptyId: string; shellPid: number }[],
    eligible: Set<string>
  ): void => expect(resolve(procs, prov, eligible)).toEqual([])

  it('rejects the /dev/tty ALIAS, which names a different terminal per process', () => {
    // `/dev/tty` is not a device — it means "my own controlling terminal" — and lsof reports it
    // verbatim without resolving it. Treated as a terminal name it collapses unrelated terminals into
    // one key: here our shell and a foreign Codex would "share" a terminal, and A would bind to a
    // conversation running somewhere else entirely.
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/tty']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/ttys001'], ['38', rollout(S1)]] },
      { pid: 900, command: 'codex', files: [['0', '/dev/tty'], ['38', rollout(S2)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1, S2]))
  })

  it('rejects /dev/tty even when it is the only name in play', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/tty']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/tty'], ['38', rollout(S1)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('two eligible top-level rollouts on one terminal', () => {
    noBind(parseOf(terminal(100, '/dev/ttys001', [S1, S2])), [{ ptyId: 'A', shellPid: 100 }], new Set([S1, S2]))
  })

  it('poisons the terminal rather than picking the uncontested rollout', () => {
    // S1 is open on two terminals and S2 on only one, so "drop the contested id, keep the clean one"
    // would bind A→S2. It must not: a terminal holding two eligible rollouts is contradictory
    // evidence about that terminal, and salvaging it would be a guess with a proof's confidence.
    const procs = parseOf([
      ...terminal(100, '/dev/ttys001', [S1, S2]),
      ...terminal(200, '/dev/ttys002', [S1])
    ])
    noBind(
      procs,
      [
        { ptyId: 'A', shellPid: 100 },
        { ptyId: 'B', shellPid: 200 }
      ],
      new Set([S1, S2])
    )
  })

  it('the same eligible rollout open on two terminals', () => {
    const procs = parseOf([
      ...terminal(100, '/dev/ttys001', [S1]),
      ...terminal(200, '/dev/ttys002', [S1])
    ])
    noBind(
      procs,
      [
        { ptyId: 'A', shellPid: 100 },
        { ptyId: 'B', shellPid: 200 }
      ],
      new Set([S1])
    )
  })

  it('two provisional PTYs claiming one terminal', () => {
    const procs = parseOf(terminal(100, '/dev/ttys001', [S1]))
    noBind(
      procs,
      [
        { ptyId: 'A', shellPid: 100 },
        { ptyId: 'B', shellPid: 100 }
      ],
      new Set([S1])
    )
  })

  it('one ptyId claiming two shells — contradictory input yields no binding at all', () => {
    // Without this the function would emit TWO bindings for one ptyId, breaking its own contract that
    // a result is unambiguous. Unreachable from the manager (its list is ptyId-keyed), but this is a
    // public pure function and the rest of the module is built on refusing contradictions.
    const procs = parseOf([...terminal(100, '/dev/ttys001', [S1]), ...terminal(200, '/dev/ttys002', [S2])])
    noBind(
      procs,
      [
        { ptyId: 'A', shellPid: 100 },
        { ptyId: 'A', shellPid: 200 }
      ],
      new Set([S1, S2])
    )
  })

  it('the shell has no fd 0 at all', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['1', '/dev/ttys001']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/ttys001'], ['38', rollout(S1)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('the shell fd 0 is not a terminal', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/null']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/ttys001'], ['38', rollout(S1)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('the shell exposes two different terminals on fd 0', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001'], ['0', '/dev/ttys002']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/ttys001'], ['38', rollout(S1)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('the shell pid is absent from the output entirely', () => {
    noBind(parseOf(terminal(100, '/dev/ttys001', [S1])), [{ ptyId: 'A', shellPid: 777 }], new Set([S1]))
  })

  it('Codex runs on a different terminal than the shell — the tmux/wrapper case', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/ttys009'], ['38', rollout(S1)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('no Codex process owns the terminal, only the shell', () => {
    const procs = parseOf([{ pid: 100, command: 'zsh', files: [['0', '/dev/ttys001']] }])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('a non-Codex process is the ONLY holder of the rollout on that terminal', () => {
    // The load-bearing half of the command gate: the terminal has an eligible rollout open on it, but
    // by a `tail`, not by Codex. Codex isn't running here at all, so there is no evidence of a session
    // — the open file is somebody reading a transcript, and binding to it would be pure fabrication.
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001']] },
      { pid: 150, command: 'tail', files: [['0', '/dev/ttys001'], ['3', rollout(S1)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('the shell itself holding a rollout open is not evidence', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001'], ['3', rollout(S1)]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('a helper holding the terminal only on a high fd does not stand in for Codex', () => {
    // codex-code-mode-host really does inherit the terminal on fd 31 while its own stdin is a socket.
    // It must not satisfy "a Codex process owns this terminal", nor contribute its open rollouts.
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001']] },
      {
        pid: 101,
        command: 'codex-code-mode-host',
        files: [['0', '->0x260c'], ['31', '/dev/ttys001'], ['38', rollout(S1)]]
      }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('only ineligible rollouts are open', () => {
    // Archived / non-interactive / zero-message / subagent rollouts are filtered out upstream, so
    // even with Codex holding one open there is nothing bindable.
    noBind(parseOf(terminal(100, '/dev/ttys001', [SUB])), [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('Codex holds no rollout open yet — the pre-first-turn state', () => {
    noBind(parseOf(terminal(100, '/dev/ttys001', [])), [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('a file that merely ends in a UUID is not a rollout', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/ttys001'], ['38', `${ROOT}/backup-${S1}.jsonl`]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('a rollout-shaped name with no trailing UUID is not a rollout', () => {
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001']] },
      { pid: 101, command: 'codex', files: [['0', '/dev/ttys001'], ['38', `${ROOT}/rollout-notes.jsonl`]] }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('a rollout copied OUTSIDE the sessions root is not the session being run', () => {
    // Codex will happily hold an exported/archived transcript open because the user asked it to read
    // one. Anchoring to Codex's own tree keeps that from being read as "this is my conversation".
    const procs = parseOf([
      { pid: 100, command: 'zsh', files: [['0', '/dev/ttys001']] },
      {
        pid: 101,
        command: 'codex',
        files: [['0', '/dev/ttys001'], ['38', `/Users/dev/Desktop/rollout-2026-08-04T11-25-20-${S1}.jsonl`]]
      }
    ])
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('an empty provisional list or empty eligible set short-circuits', () => {
    const procs = parseOf(terminal(100, '/dev/ttys001', [S1]))
    noBind(procs, [], new Set([S1]))
    noBind(procs, [{ ptyId: 'A', shellPid: 100 }], new Set())
  })

  it('malformed output binds nothing', () => {
    noBind(parseLsof('this is not lsof output at all'), [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })

  it('output truncated before the rollout record binds nothing', () => {
    const full = lsofText(terminal(100, '/dev/ttys001', [S1]))
    noBind(parseLsof(full.slice(0, full.indexOf('f38'))), [{ ptyId: 'A', shellPid: 100 }], new Set([S1]))
  })
})

/**
 * The real `execFile` path, driven by stub binaries. These cover the three branches that decide
 * whether output may be trusted — the ones that stand between a truncated probe and a wrong bind.
 */
describe('resolveCodexBindings — the exec path', () => {
  const DIR = join(process.env.CLAUDE_CODE_TMPDIR ?? tmpdir(), 'sb-codexidentity-test')
  const FIXTURE = join(DIR, 'fixture.bin')
  const PARTIAL = join(DIR, 'partial.bin')
  const NO_NEWLINE = join(DIR, 'nonewline.bin')
  const ARGV_LOG = join(DIR, 'argv.txt')
  /** Emits a complete capture and exits 1 — the routine "one requested pid had already died" case. */
  const STUB_EXIT1 = join(DIR, 'exit1.sh')
  /** Emits a truncated capture, then hangs so the timeout kills it mid-probe. */
  const STUB_HANG = join(DIR, 'hang.sh')
  /** Emits output with no terminating newline: cut off mid-stream. */
  const STUB_NO_NEWLINE = join(DIR, 'nonewline.sh')
  /** Emits far more than the caller's maxBuffer allows. */
  const STUB_FLOOD = join(DIR, 'flood.sh')

  const prov = [{ ptyId: 'A', shellPid: 2202 }]
  const opts = { sessionsRoot: ROOT }

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(FIXTURE, REAL_CAPTURE)
    // A CONTESTED terminal — two eligible rollouts open — cut cleanly between them, at a record
    // boundary so the trailing-newline check can't catch it. This shape is deliberate: truncating away
    // the *only* rollout would make "no bind" the right answer either way, proving nothing. Here the
    // full output must bind NOTHING, while the cut output looks exact and would bind A→S1. That is
    // precisely the de-poisoning a truncated probe causes, and the only way to prove the guard works.
    const contested = lsofText(terminal(2202, '/dev/ttys001', [S1, S2]))
    const cut = contested.slice(0, contested.indexOf('f39'))
    expect(cut.endsWith('\n')).toBe(true)
    writeFileSync(PARTIAL, cut)
    writeFileSync(NO_NEWLINE, REAL_CAPTURE.replace(/\n$/, ''))
    const script = (body: string): string => `#!/bin/sh\n${body}\n`
    writeFileSync(STUB_EXIT1, script(`printf '%s' "$*" > ${ARGV_LOG}\ncat ${FIXTURE}\nexit 1`))
    writeFileSync(STUB_HANG, script(`cat ${PARTIAL}\nsleep 30`))
    writeFileSync(STUB_NO_NEWLINE, script(`cat ${NO_NEWLINE}`))
    writeFileSync(STUB_FLOOD, script(`cat ${FIXTURE}\ncat ${FIXTURE}\ncat ${FIXTURE}`))
    for (const s of [STUB_EXIT1, STUB_HANG, STUB_NO_NEWLINE, STUB_FLOOD]) chmodSync(s, 0o755)
  })

  afterAll(() => rmSync(DIR, { recursive: true, force: true }))

  it('parses a COMPLETE capture even though the command exited 1', async () => {
    // The single most important behavior of the exec path. lsof exits 1 whenever any requested pid has
    // died — while printing perfect output for the rest — and provisional pids are snapshotted before
    // the probe, so this happens routinely. Bailing on the exit code would disable binding at random.
    await expect(
      resolveCodexBindings(prov, new Set([S1]), { ...opts, lsofPath: STUB_EXIT1 })
    ).resolves.toEqual([{ ptyId: 'A', sessionId: S1 }])
  })

  it('passes exactly the intended argv — a union of -p and -c, never intersected', async () => {
    await resolveCodexBindings(prov, new Set([S1]), { ...opts, lsofPath: STUB_EXIT1 })
    const argv = readFileSync(ARGV_LOG, 'utf8')
    expect(argv).toBe('-n -p 2202 -c codex -F0pcfn')
    // `-a` would intersect "these shell pids" with "processes named codex" and return neither side.
    expect(argv).not.toContain('-a')
  })

  it('discards output from a probe killed by the timeout, even though it looks well-formed', async () => {
    // The stub emits a contested terminal cut between its two rollout records, then hangs until the
    // timeout kills it. What arrived is syntactically perfect and newline-terminated — it just describes
    // a terminal holding ONE rollout when it really holds two. Parsing it binds the wrong conversation
    // with full confidence, which is why a killed probe is thrown away rather than salvaged.
    await expect(
      resolveCodexBindings(prov, new Set([S1, S2]), { ...opts, lsofPath: STUB_HANG, timeoutMs: 300 })
    ).resolves.toEqual([])
  })

  it('discards output that does not end in a newline', async () => {
    // lsof always terminates its final record with one, so a missing newline means a cut mid-stream.
    await expect(
      resolveCodexBindings(prov, new Set([S1]), { ...opts, lsofPath: STUB_NO_NEWLINE })
    ).resolves.toEqual([])
  })

  it('discards output that overflowed the buffer', async () => {
    await expect(
      resolveCodexBindings(prov, new Set([S1]), { ...opts, lsofPath: STUB_FLOOD, maxBuffer: 64 })
    ).resolves.toEqual([])
  })

  it('resolves to [] when the lsof binary is missing', async () => {
    await expect(
      resolveCodexBindings(prov, new Set([S1]), { ...opts, lsofPath: '/nonexistent/lsof' })
    ).resolves.toEqual([])
  })

  it('resolves to [] when the command fails with no output', async () => {
    await expect(
      resolveCodexBindings(prov, new Set([S1]), { ...opts, lsofPath: '/usr/bin/false' })
    ).resolves.toEqual([])
  })

  it('never spawns anything when there is nothing to resolve', async () => {
    // An unspawnable path proves the short-circuits return before exec.
    const bad = { ...opts, lsofPath: '/nonexistent/lsof' }
    await expect(resolveCodexBindings([], new Set([S1]), bad)).resolves.toEqual([])
    await expect(resolveCodexBindings(prov, new Set(), bad)).resolves.toEqual([])
    await expect(resolveCodexBindings([{ ptyId: 'A', shellPid: 0 }], new Set([S1]), bad)).resolves.toEqual(
      []
    )
  })
})
