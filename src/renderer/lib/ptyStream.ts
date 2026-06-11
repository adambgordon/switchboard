/**
 * Single global subscription to PTY output, with per-pty backlog buffering.
 *
 * A live session can emit bytes between `resume()` resolving and the moment its
 * <TerminalView> mounts and subscribes. Without buffering, those early bytes
 * (the shell prompt, the start of `claude`) are lost. We subscribe ONCE at app
 * start, buffer output per ptyId, and replay the backlog when a terminal attaches.
 */
type Writer = (data: string) => void

const buffers = new Map<string, string[]>()
const writers = new Map<string, Writer>()
let started = false

function ensureStarted(): void {
  if (started) return
  started = true
  window.api.onPtyData((id: string, data: string) => {
    const w = writers.get(id)
    if (w) {
      w(data)
    } else {
      const b = buffers.get(id) ?? []
      b.push(data)
      if (b.length > 4000) b.shift()
      buffers.set(id, b)
    }
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
  }
  writers.set(id, writer)
  return () => {
    if (writers.get(id) === writer) writers.delete(id)
  }
}
