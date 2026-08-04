/**
 * Authoritative identity for a freshly-spawned Codex PTY: which indexed rollout does the Codex
 * process running in THIS terminal actually have open?
 *
 * Why this exists at all. Claude lets Switchboard impose the id (`claude --session-id <uuid>`), so a
 * Claude PTY's identity is settled at spawn. Codex mints its own id, offers no flag to override it,
 * and does not write the rollout file until the first real turn — so a new-Codex PTY starts life with
 * a placeholder id and has to learn its real one later.
 *
 * Why it uses the OS rather than time. Four successive timing heuristics were tried and each was
 * broken by a real counterexample: spawn order (an untouched older tab stole a used tab's rollout),
 * "input contained \r" (a bracketed paste looked like a submit), a discrete post-boot Enter (Enter on
 * an empty composer produces no rollout, yet still competed), and nearest-timestamp pairing (nearest
 * is not causal — a first turn processed late loses to the next tab's submit). The lesson, stated
 * once so it isn't relearned: TIMING CAN SUGGEST IDENTITY BUT CANNOT PROVE IT. A missed bind is a
 * terminal that works but isn't linked to its row — visible, bounded, recoverable. A WRONG bind puts
 * a row's Terminal on one conversation and its Formatted view on another, and feeds the liveness dot
 * another process's timestamps, so every view lies at once.
 *
 * So identity comes from evidence the OS already owns: a live Codex process holds its rollout file
 * open, and both that process and the shell Switchboard spawned expose file descriptor 0 as the same
 * `/dev/tty…` device. `lsof` reads that graph. A bind happens ONLY when the graph has exactly one
 * answer — one terminal device, one provisional Switchboard PTY, one eligible rollout. Anything
 * missing, duplicated, or contradictory yields NO binding; there is deliberately no fallback.
 *
 * Pure Node — no Electron, no DOM. `parseLsof` and `resolveBindings` are pure so the whole rule set
 * is testable from fixtures without spawning anything. Raw `lsof` output is never logged: it is a
 * list of the user's open file paths.
 */

import { execFile } from 'node:child_process'
import path from 'node:path'
import { defaultCodexRoot, sessionIdFromPath } from '../sessions/codexParser'

/** A new-Codex PTY that has not yet learned its real rollout id. `shellPid` is node-pty's `proc.pid`
 *  — the login shell Switchboard spawned, which shares its controlling terminal with the Codex
 *  process it went on to launch. */
export interface ProvisionalPty {
  ptyId: string
  shellPid: number
}

/** A proven PTY↔rollout association. Only ever emitted for exact, unambiguous evidence. */
export interface CodexBinding {
  ptyId: string
  sessionId: string
}

/** One open file of one process, as reported by `lsof -F0…`. */
export interface LsofFile {
  /** The raw descriptor field: a number for real fds, or `cwd` / `txt` / `mem` etc. */
  fd: string
  /** The raw name field. NOT always a path — sockets appear as `->0x…`, kqueues as `count=0, …`. */
  name: string
}

/** One process and its open files, as reported by `lsof -F0…`. */
export interface LsofProcess {
  pid: number
  command: string
  files: LsofFile[]
}

export interface ProbeOptions {
  /** Absolute path to lsof. Overridable so the failure paths are genuinely testable rather than
   *  reasoned about — a stub can emit a fixture and exit 1, or hang until the timeout kills it. */
  lsofPath?: string
  timeoutMs?: number
  maxBuffer?: number
  /** Root the open rollout paths must sit under. Defaults to Codex's own sessions directory. */
  sessionsRoot?: string
}

const LSOF_PATH = '/usr/sbin/lsof'
/** The measured probe is ~40ms; this is a generous ceiling, not a typical value. Bounded so a wedged
 *  lsof can never stall the re-index path that schedules it. */
const LSOF_TIMEOUT_MS = 2000
/** Bounded so pathological output can't balloon main's memory. A two-process probe is ~5KB. */
const LSOF_MAX_BUFFER = 4 * 1024 * 1024

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** lsof's `f` field is the bare descriptor in `-F` mode, but tolerate a trailing access-mode
 *  character (`0u`) in case that ever differs — cheap insurance against a format variation. */
const FD_ZERO_RE = /^0[rwu\-]?$/

/**
 * Is this the name of a specific terminal DEVICE (`/dev/ttys004`)?
 *
 * The bare `/dev/tty` is excluded, and that exclusion is load-bearing rather than tidy-mindedness:
 * `/dev/tty` is not a device, it is an alias meaning "whichever terminal the calling process is
 * attached to" — so it names a DIFFERENT terminal for every process that opens it. lsof reports it
 * verbatim without resolving it (verified: a process showed `f0 /dev/ttys004` and `f3 /dev/tty`
 * simultaneously). Used as a map key it would make two processes on two unrelated terminals look like
 * one, which is exactly the cross-terminal wrong bind this module exists to make impossible. Today's
 * Codex inherits its stdin so it reports a real device, but reopening `/dev/tty` as stdin is a common
 * TUI pattern — one upstream change away.
 */
function isTtyName(name: string): boolean {
  return name.startsWith('/dev/tty') && name !== '/dev/tty'
}

/** `-c codex` is a PREFIX match, so this legitimately covers helpers like `codex-code-mode-host`.
 *  They are filtered out later by the fd-0 rule (their stdin is a socket, not the terminal), not
 *  here — a helper that genuinely owns the terminal should still count toward "Codex is running". */
function isCodexCommand(command: string): boolean {
  return command.startsWith('codex')
}

/**
 * The rollout id an open file's name encodes, or null when it isn't a Codex rollout. Three gates: the
 * path must sit under Codex's own sessions root, the basename must have the `rollout-*.jsonl` shape,
 * and the existing trailing-UUID rule must actually have found a UUID (rather than falling back to
 * returning the basename).
 *
 * The eligible-id intersection downstream is the primary filter; these narrow what can even be
 * considered, so a copied or exported transcript sitting elsewhere on disk — which Codex may well have
 * open because the user asked it to read one — can never be mistaken for the session it is running.
 */
function rolloutSessionId(name: string, sessionsRoot: string): string | null {
  if (!name.startsWith(sessionsRoot + path.sep)) return null
  const base = path.basename(name)
  if (!base.startsWith('rollout-') || !base.endsWith('.jsonl')) return null
  const id = sessionIdFromPath(name)
  return UUID_RE.test(id) ? id : null
}

/**
 * Parse `lsof -F0pcfn` output. The format is newline-separated SETS of NUL-TERMINATED fields (note
 * terminated, not separated — each field ends with `\0`, so a set reads `p2217\0cnode\0`). A process
 * set carries `p<pid>` + `c<command>`; each following file set carries `f<fd>` + `n<name>` and
 * belongs to the most recent process set.
 *
 * Deliberately total: unknown field types, sets before any process header, a non-numeric pid, and
 * truncated tails are all skipped rather than thrown. Pure.
 */
export function parseLsof(raw: string): LsofProcess[] {
  const out: LsofProcess[] = []
  const byPid = new Map<number, LsofProcess>()
  let current: LsofProcess | null = null

  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    let pid: number | null = null
    let command: string | null = null
    let fd: string | null = null
    let name: string | null = null

    for (const field of line.split('\0')) {
      if (field.length === 0) continue
      const tag = field[0]
      const value = field.slice(1)
      if (tag === 'p') {
        // Digits only, deliberately: `Number()` would also accept `0x10` and `1e3` as valid pids.
        pid = /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : null
      } else if (tag === 'c') command = value
      else if (tag === 'f') fd = value
      else if (tag === 'n') name = value
      // any other field type: ignored
    }

    if (pid != null) {
      // A new process set. A pid can legitimately appear more than once; merge rather than replace
      // so no file record is silently dropped. A repeat that disagrees about the command keeps the
      // first — the safe direction, since forgetting that a process is `codex` only ever loses
      // evidence (a missed bind), where adopting it could manufacture some.
      const existing = byPid.get(pid)
      if (existing) {
        if (command != null && existing.command.length === 0) existing.command = command
        current = existing
      } else {
        current = { pid, command: command ?? '', files: [] }
        byPid.set(pid, current)
        out.push(current)
      }
      // Fall through rather than `continue`: real lsof puts p/c on their own line, but if a set ever
      // carried a file inline it must still be recorded. Dropping it is the DE-POISONING direction —
      // it could turn a terminal holding two rollouts into one holding a single, apparently exact one.
    }
    // A file record only means anything in the context of a process.
    if (current != null && fd != null && name != null) current.files.push({ fd, name })
  }

  return out
}

/** The distinct `/dev/tty…` names this process exposes on fd 0 — its controlling terminal. Only fd 0
 *  counts: the same device also shows up on fds 1, 2 and (observed) 31, and on helper processes that
 *  merely INHERITED the terminal, so widening this would let a helper impersonate the session owner. */
function fdZeroTtys(proc: LsofProcess): Set<string> {
  const ttys = new Set<string>()
  for (const f of proc.files) {
    if (FD_ZERO_RE.test(f.fd) && isTtyName(f.name)) ttys.add(f.name)
  }
  return ttys
}

/** The single fd-0 terminal of a process, or null when there is none or more than one. */
function soleTty(proc: LsofProcess): string | null {
  const ttys = fdZeroTtys(proc)
  return ttys.size === 1 ? [...ttys][0] : null
}

/**
 * Apply the binding rules to one observation. Pure, so every ambiguity case is testable from
 * fixtures. A pairing survives only if ALL of these hold:
 *
 *   1. the PTY's shell exposes exactly one `/dev/tty…` on fd 0;
 *   2. that terminal belongs to exactly one provisional Switchboard PTY;
 *   3. at least one `codex*` process holds that same terminal on fd 0;
 *   4. the eligible rollouts open on those Codex processes are collected as a set;
 *   5. that set has exactly one member;
 *   6. that member is not also open on another terminal.
 *
 * Rules 3 and 5 collapse into one check, because only a Codex process that owns the terminal can put
 * anything in the set — see the comment at the collection loop. Rollouts held open by anything else
 * (an editor, a `tail -f`, the shell itself) are ignored rather than counted or treated as a conflict:
 * the evidence being read is specifically "which rollout is Codex writing".
 *
 * Note rule 5 POISONS rather than filters: two eligible rollouts on one terminal bind neither, even
 * if one of them would be unambiguous elsewhere. Two open rollouts mean the evidence for that
 * terminal is genuinely contradictory (Codex really does hold subagent rollouts open alongside its
 * own), and picking the "less contested" one would be a guess wearing a proof's clothing.
 */
export function resolveBindings(
  procs: readonly LsofProcess[],
  provisional: readonly ProvisionalPty[],
  eligibleSessionIds: ReadonlySet<string>,
  sessionsRoot: string = defaultCodexRoot()
): CodexBinding[] {
  if (provisional.length === 0 || eligibleSessionIds.size === 0) return []

  const byPid = new Map<number, LsofProcess>()
  for (const p of procs) byPid.set(p.pid, p)

  // One ptyId claiming two shell pids is contradictory input, and emitting two bindings for it would
  // break this function's own contract. Refuse the id outright rather than picking one of its pids.
  const seen = new Set<string>()
  const conflicted = new Set<string>()
  for (const p of provisional) {
    if (seen.has(p.ptyId)) conflicted.add(p.ptyId)
    seen.add(p.ptyId)
  }

  // Rules 1-2: terminal -> the provisional PTYs claiming it.
  const ptysByTty = new Map<string, string[]>()
  for (const p of provisional) {
    if (conflicted.has(p.ptyId)) continue
    const proc = byPid.get(p.shellPid)
    if (!proc) continue
    const tty = soleTty(proc)
    if (tty == null) continue
    const list = ptysByTty.get(tty)
    if (list) list.push(p.ptyId)
    else ptysByTty.set(tty, [p.ptyId])
  }
  if (ptysByTty.size === 0) return []

  // Rules 3-4: terminal -> eligible rollouts held open by the Codex process(es) that own it.
  // Rule 3 needs no separate check: ONLY a `codex*` process whose fd 0 is this terminal can put an
  // id in this map, so a non-empty set is itself the proof that Codex owns the terminal. A standalone
  // "is there a Codex process here" branch would be unreachable — and an unreachable guard can't be
  // tested, which is how a suite ends up green without exercising the rule it claims to enforce.
  const sessionsByTty = new Map<string, Set<string>>()
  for (const proc of procs) {
    if (!isCodexCommand(proc.command)) continue
    const tty = soleTty(proc)
    if (tty == null) continue
    for (const f of proc.files) {
      const id = rolloutSessionId(f.name, sessionsRoot)
      if (id == null || !eligibleSessionIds.has(id)) continue
      const set = sessionsByTty.get(tty)
      if (set) set.add(id)
      else sessionsByTty.set(tty, new Set([id]))
    }
  }

  // Rule 6 input: rollout -> the terminals it is open on.
  const ttysBySession = new Map<string, Set<string>>()
  for (const [tty, ids] of sessionsByTty) {
    for (const id of ids) {
      const set = ttysBySession.get(id)
      if (set) set.add(tty)
      else ttysBySession.set(id, new Set([tty]))
    }
  }

  const out: CodexBinding[] = []
  for (const [tty, ptyIds] of ptysByTty) {
    if (ptyIds.length !== 1) continue // rule 2: two PTYs on one terminal is contradictory
    const ids = sessionsByTty.get(tty)
    if (ids == null || ids.size !== 1) continue // rules 3 + 5
    const sessionId = [...ids][0]
    if (ttysBySession.get(sessionId)?.size !== 1) continue // rule 6
    out.push({ ptyId: ptyIds[0], sessionId })
  }

  // Stable order so a result never depends on Map insertion order (i.e. on lsof's record order).
  out.sort((a, b) => (a.ptyId === b.ptyId ? 0 : a.ptyId < b.ptyId ? -1 : 1))
  return out
}

/**
 * Observe the OS and return the provable PTY↔rollout bindings. Resolves to `[]` on any failure —
 * missing binary, timeout, permission denial, malformed output, or simple ambiguity. Callers must
 * treat an empty result as "identity unknown", never as "nothing changed".
 *
 * `-p` and `-c` form a UNION, which is the whole point: `-p` brings in the shells Switchboard owns
 * and `-c` brings in the Codex processes, and the relationship between them is what's being read.
 * Adding `-a` would intersect the two selectors and return neither side. Arguments are passed as an
 * argv array with no shell, and pids come from node-pty as integers.
 */
export async function resolveCodexBindings(
  provisional: readonly ProvisionalPty[],
  eligibleSessionIds: ReadonlySet<string>,
  opts: ProbeOptions = {}
): Promise<readonly CodexBinding[]> {
  if (provisional.length === 0 || eligibleSessionIds.size === 0) return []
  const pids = [...new Set(provisional.map((p) => p.shellPid))].filter(
    (n) => Number.isInteger(n) && n > 0
  )
  if (pids.length === 0) return []

  const raw = await runLsof(pids, opts)
  if (raw == null) return []
  return resolveBindings(
    parseLsof(raw),
    provisional,
    eligibleSessionIds,
    opts.sessionsRoot ?? defaultCodexRoot()
  )
}

/**
 * Run the probe and return stdout, or null when the output can't be trusted.
 *
 * The central trap, verified against lsof 4.91 on macOS: **lsof exits 1 whenever ANY requested pid no
 * longer exists**, while still printing complete, correct output for the ones that do (measured: one
 * live + one dead pid → exit 1, 347 bytes, all live records present, empty stderr). Provisional pids
 * are snapshotted before the probe, so a terminal closing mid-probe makes that routine — and treating
 * a nonzero exit as failure would disable binding at random. So a clean nonzero exit IS parsed.
 *
 * Truncated output, by contrast, must NEVER be parsed: dropping records is the DE-POISONING direction,
 * able to turn a genuinely ambiguous terminal (two rollouts open) into an apparently exact one — a
 * wrong bind, the failure this module exists to prevent. Rather than enumerate the truncating modes,
 * the test is inverted: trust output ONLY on a clean exit — a numeric exit code, no signal, not
 * killed — so the timeout kill, a maxBuffer overflow (which presents as a `RangeError` with neither
 * `killed` nor `signal` set), ENOENT, and any future failure shape all fail closed by default.
 *
 * Plus a completeness check: lsof always terminates its last record with a newline, so non-empty
 * output lacking one was cut off mid-stream.
 *
 * Residual, stated rather than papered over: lsof can skip an individual fd it cannot stat, warn, and
 * still exit cleanly — record loss indistinguishable from the file simply not being open. stderr is
 * not a usable signal for it (measured empty even for permission-denied probes of root processes).
 * This is accepted: it needs a fd we own to become unstattable, and it degrades to a missed bind
 * unless it lands on the second rollout of a contested terminal.
 */
function runLsof(pids: number[], opts: ProbeOptions): Promise<string | null> {
  const args = ['-n', '-p', pids.join(','), '-c', 'codex', '-F0pcfn']
  return new Promise((resolve) => {
    execFile(
      opts.lsofPath ?? LSOF_PATH,
      args,
      {
        timeout: opts.timeoutMs ?? LSOF_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? LSOF_MAX_BUFFER,
        killSignal: 'SIGKILL',
        encoding: 'utf8'
      },
      (err, stdout) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
          // Never log `err`: its message quotes the argv, and stdout lists the user's open files.
          const cleanExit = typeof e.code === 'number' && e.signal == null && e.killed !== true
          if (!cleanExit) return resolve(null)
        }
        const raw = typeof stdout === 'string' ? stdout : ''
        if (raw.length > 0 && !raw.endsWith('\n')) return resolve(null)
        resolve(raw)
      }
    )
  })
}
