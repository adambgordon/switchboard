/**
 * Single global subscription to PTY output, with per-pty backlog buffering.
 *
 * A live session can emit bytes between `resume()` resolving and the moment its
 * <TerminalView> mounts and subscribes. Without buffering, those early bytes
 * (the shell prompt, the start of `claude`) are lost. We subscribe ONCE at app
 * start, buffer output per ptyId, and replay the backlog when a terminal attaches.
 */
type Writer = (data: string) => void

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
 * How much output to hold for a terminal with no writer attached, per terminal.
 *
 * Bounded in BYTES rather than chunks because chunk sizes vary by orders of magnitude, and because
 * every window receives every terminal's output: a window showing one conversation still sees the
 * rest, and those have no writer in it to consume them. A chunk count leaves the real ceiling
 * unstated; this states it.
 */
const MAX_BUFFER_BYTES = 256 * 1024

const buffers = new Map<string, string[]>()
const bufferBytes = new Map<string, number>()
const writers = new Map<string, Writer>()
let started = false

function ensureStarted(): void {
  if (started) return
  started = true
  window.api.onPtyData((id: string, data: string) => {
    const w = writers.get(id)
    if (w) {
      w(data)
      return
    }
    const b = buffers.get(id) ?? []
    b.push(data)
    let bytes = (bufferBytes.get(id) ?? 0) + data.length
    // Drop from the FRONT: the newest output is what a terminal attaching later needs to show.
    while (bytes > MAX_BUFFER_BYTES && b.length > 1) bytes -= b.shift()!.length
    buffers.set(id, b)
    bufferBytes.set(id, bytes)
  })
}

/** Call once at app startup so buffering begins before any session is spawned. */
export function initPtyStream(): void {
  ensureStarted()
}

/** Attach a live writer for a pty; flushes any buffered backlog first. Returns detach. */
export function attachPty(id: string, writer: Writer): () => void {
  ensureStarted()
  const backlog = buffers.get(id)
  if (backlog) {
    for (const d of backlog) writer(d)
    buffers.delete(id)
    bufferBytes.delete(id)
  }
  writers.set(id, writer)
  return () => {
    if (writers.get(id) === writer) writers.delete(id)
  }
}
