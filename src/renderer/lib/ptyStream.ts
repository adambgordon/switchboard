/**
 * Single global subscription to PTY output, with a per-terminal rolling record of recent output.
 *
 * Two jobs. The first is the original one: a live session can emit bytes between `resume()` resolving
 * and its <TerminalView> mounting, and without a buffer those early bytes (the shell prompt, the start
 * of the agent) are lost.
 *
 * The second is why the record is RETAINED rather than drained. Nothing else anywhere keeps PTY
 * output — main does not, and the agents do not — so a terminal that attaches to an empty record shows
 * a blank screen until something produces more output. Since an xterm is destroyed and rebuilt whenever
 * it changes pane or window (one writer per terminal; see below), a drained buffer made "move this
 * terminal" synonymous with "blank this terminal". Keeping a bounded window of recent output instead
 * lets the rebuilt terminal repaint itself, which is what makes moving one between panes and windows a
 * real operation rather than a destructive one.
 *
 * The record is therefore a rolling window, not a queue: every chunk is recorded whether or not anyone
 * is listening, and attaching replays without consuming.
 */
type Writer = (data: string) => void

/**
 * How much output to retain per terminal.
 *
 * Bounded in BYTES rather than chunks because chunk sizes vary by orders of magnitude, and because
 * every window receives every terminal's output: a window showing one conversation still sees the
 * rest. A chunk count leaves the real ceiling unstated; this states it. The ceiling is per terminal and
 * terminals are themselves capped (maxLivePtys), so total retention is bounded.
 */
const MAX_BUFFER_BYTES = 256 * 1024

/**
 * The one thing this module needs from the preload bridge, declared locally.
 *
 * This module is imported by a unit test, and tests compile under the node tsconfig — which carries no
 * DOM lib, so the ambient `window` does not exist there. Declaring the dependency here states exactly
 * which member is used instead of pulling the whole DOM in to get it, and it shadows the global in
 * this file only.
 *
 * It is a declaration, not an injection seam: the subscription cannot be handed in at startup because
 * `attachPty` self-starts. `initPtyStream` runs in an App effect and `attachPty` in a TerminalView
 * one, and React runs child effects first — so a terminal mounting in the same commit as the app
 * genuinely attaches before init, and the lazy start is what makes that ordering safe rather than
 * silently unsubscribed.
 */
declare const window: {
  api: { onPtyData: (cb: (id: string, data: string) => void) => void }
}

/**
 * One terminal's retained output and its running size.
 *
 * Deliberately a single record rather than two maps keyed by the same id. The size is derived from the
 * chunks, so as separate maps they could disagree — and the way they disagreed was invisible: dropping
 * a terminal's chunks while leaving its size behind leaks a number per dead terminal and, on the
 * unreachable path where an id came back, would evict from a record that had only just started. Held
 * together, neither can outlive the other and there is nothing left to keep in step.
 */
interface Retained {
  chunks: string[]
  bytes: number
}

const retained = new Map<string, Retained>()
const writers = new Map<string, Writer>()
let started = false

/** Append to a terminal's rolling record, evicting from the front to stay under the cap. */
function record(id: string, data: string): void {
  const r = retained.get(id) ?? { chunks: [], bytes: 0 }
  r.chunks.push(data)
  r.bytes += data.length
  // Drop from the FRONT: the newest output is what a terminal attaching later needs to show. The
  // `length > 1` floor keeps a single chunk that alone exceeds the cap, because replaying more than
  // the budget once is better than replaying nothing and showing an empty screen.
  while (r.bytes > MAX_BUFFER_BYTES && r.chunks.length > 1) r.bytes -= r.chunks.shift()!.length
  retained.set(id, r)
}

function ensureStarted(): void {
  if (started) return
  started = true
  window.api.onPtyData((id: string, data: string) => {
    // Recorded ALWAYS, then delivered if anyone is listening. Recording unconditionally is the whole
    // mechanism: it means the record still describes the screen at the moment a terminal is rebuilt
    // somewhere else, which a drain-on-attach buffer could not.
    record(id, data)
    writers.get(id)?.(data)
  })
}

/** Call once at app startup so recording begins before any session is spawned. */
export function initPtyStream(): void {
  ensureStarted()
}

/**
 * Attach a live writer for a pty, first replaying whatever output is retained. Returns detach.
 *
 * Replay does not consume, and cannot duplicate: every caller attaches a freshly-constructed terminal.
 * TerminalView builds its `Terminal` and calls this inside one effect and disposes it in that effect's
 * cleanup, so an attach never lands on a screen that already holds this output.
 */
export function attachPty(id: string, writer: Writer): () => void {
  ensureStarted()
  const backlog = retained.get(id)
  if (backlog) for (const d of backlog.chunks) writer(d)
  writers.set(id, writer)
  return () => {
    // Only the CURRENT writer may unhook itself. A superseded terminal's cleanup runs after its
    // replacement has already attached, and without this guard it would unhook the live one — output
    // would then accumulate silently behind a visible terminal.
    if (writers.get(id) === writer) writers.delete(id)
  }
}

/**
 * Forget output for terminals that no longer exist.
 *
 * Retention is unbounded in TIME, so it needs an end: without this, a window accumulates one full
 * buffer for every terminal it has ever seen, including all the dead ones. Expressed as "keep these"
 * rather than "drop this one" so it is driven by the live set the app already has, and cannot leak
 * through a missed teardown path.
 */
export function retainOnly(liveIds: Set<string>): void {
  for (const id of retained.keys()) {
    if (!liveIds.has(id)) retained.delete(id)
  }
}
