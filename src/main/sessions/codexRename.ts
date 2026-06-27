/**
 * Renaming a Codex conversation.
 *
 * Unlike Claude (where a rename is a `custom-title` line appended to the JSONL the parser already
 * reads — see rename.ts), Codex has no on-disk title in its rollout. The sanctioned write is the
 * Codex **app-server** RPC `thread/name/set`, which updates Codex's OWN store (`state_*.sqlite`
 * `threads.title`) — not the rollout. So this write pairs with a read of that DB (codexThreadsDb.ts)
 * for the rename to actually surface.
 *
 * Transport (verified empirically against codex-cli 0.142.2): JSON-RPC-like messages, newline-
 * delimited (NDJSON), over the app-server's stdio. Handshake:
 *   1. -> initialize { clientInfo: { name, version } }
 *   2. <- result { ... }
 *   3. -> initialized        (notification, no id)
 *   4. -> thread/name/set { threadId, name }
 *   5. <- result {}          (and a thread/name/updated notification we ignore)
 * The server also emits unsolicited notifications (e.g. remoteControl/status/changed) that the
 * sequencer simply ignores.
 *
 * Pure Node — no Electron, no DOM. `createRenameProtocol` is a pure state machine (no I/O) so the
 * handshake sequencing is unit-testable without spawning a process.
 */

import { spawn } from 'node:child_process'

const CLIENT_INFO = { name: 'switchboard', version: '0.0.0' }
const TIMEOUT_MS = 10_000

/** A JSON-RPC-like message (request, notification, or response). Shape is intentionally loose. */
type RpcMessage = Record<string, unknown>

/** Outcome of feeding one server message to the protocol: what to send next, and whether we're done. */
interface ProtocolStep {
  send: RpcMessage[]
  done?: 'ok' | 'error'
  error?: string
}

export interface RenameProtocol {
  /** Messages to send immediately once the channel is open. */
  start(): RpcMessage[]
  /** Feed one parsed server message; returns messages to send next and any terminal outcome. */
  next(msg: RpcMessage): ProtocolStep
}

function describeError(err: unknown): string {
  if (err == null) return 'unknown error'
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Pure handshake state machine for renaming a thread. Drives initialize -> initialized ->
 * thread/name/set, resolving when the rename's response arrives. Ignores everything else (unsolicited
 * notifications, the initialize result body), so callers can feed it the raw message stream verbatim.
 */
export function createRenameProtocol(threadId: string, name: string): RenameProtocol {
  return {
    start() {
      return [{ id: 1, method: 'initialize', params: { clientInfo: CLIENT_INFO } }]
    },
    next(msg) {
      const isResponse = msg.result !== undefined || msg.error !== undefined
      if (msg.id === 1 && isResponse) {
        if (msg.error !== undefined) return { send: [], done: 'error', error: describeError(msg.error) }
        return {
          send: [
            { method: 'initialized' },
            { id: 2, method: 'thread/name/set', params: { threadId, name } }
          ]
        }
      }
      if (msg.id === 2 && isResponse) {
        if (msg.error !== undefined) return { send: [], done: 'error', error: describeError(msg.error) }
        return { send: [], done: 'ok' }
      }
      return { send: [] }
    }
  }
}

/**
 * Rename a Codex thread (threadId === the conversation's sessionId) via a one-shot `codex app-server`.
 * Resolves on success, rejects on RPC error / timeout / spawn failure (e.g. `codex` not on PATH).
 *
 * Spawned through the user's LOGIN+INTERACTIVE shell (`$SHELL -lic 'exec codex app-server'`) — the
 * same way the PtyManager and the availability probe resolve PATH (the packaged app's own env has a
 * minimal PATH). `exec` replaces the shell with codex so stdio is a clean pipe.
 */
export function renameCodexThread(threadId: string, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const child = spawn(shell, ['-lic', 'exec codex app-server'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const protocol = createRenameProtocol(threadId, name)

    let settled = false
    let buf = ''
    const send = (msg: RpcMessage): void => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + '\n')
    }
    const settle = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      if (err) reject(err)
      else resolve()
    }
    const timer = setTimeout(() => settle(new Error('codex app-server rename timed out')), TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: RpcMessage
        try {
          msg = JSON.parse(line)
        } catch {
          continue // tolerate shell/profile noise on stdout
        }
        const step = protocol.next(msg)
        for (const out of step.send) send(out)
        if (step.done === 'ok') settle()
        else if (step.done === 'error') settle(new Error(`thread/name/set failed: ${step.error}`))
      }
    })

    child.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
    child.on('exit', (code) => settle(new Error(`codex app-server exited before rename (code ${code})`)))

    for (const out of protocol.start()) send(out)
  })
}
