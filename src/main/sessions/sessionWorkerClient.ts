/**
 * Main-process client for the session-parsing worker. Jobs go through a {@link JobQueue} owned here,
 * so the worker only ever holds the few jobs that are running and a foreground job (a file a live
 * session is writing) is never stuck behind a background backlog (a full re-parse after an update).
 *
 * Fails safe: if the worker errors or exits, every job it was holding — and every later one — is
 * answered by the in-process parser instead, so nothing waiting on a job can hang on a dead worker.
 *
 * No Electron and no bundler imports: the caller passes in how to start the worker.
 */

import type { AgentKind, ConversationMeta } from '../../shared/types'
import { JobQueue, type JobPriority } from './jobQueue'
import type { SessionJob, SessionWorkerReply, SessionWorkerRequest } from './sessionWorkerProtocol'

/** The slice of `node:worker_threads` Worker this client uses — so a test can stand in for it. */
export interface WorkerLike {
  on(event: 'message', listener: (reply: SessionWorkerReply) => void): unknown
  on(event: 'error' | 'exit', listener: () => void): unknown
  postMessage(request: SessionWorkerRequest): void
  terminate(): Promise<unknown>
}

/** Parse one session file's sidebar metadata in-process; must resolve null on any failure. */
export type InProcessMeta = (agent: AgentKind, path: string) => Promise<ConversationMeta | null>

/** Jobs handed to the worker at once. Parsing is CPU-bound in one thread, so more buys nothing. */
export const WORKER_JOB_LIMIT = 4

export class SessionWorkerClient {
  private readonly queue: JobQueue<SessionJob, ConversationMeta | null>
  private readonly inFlight = new Map<number, { job: SessionJob; resolve: (meta: ConversationMeta | null) => void }>()
  private worker: WorkerLike | null
  private nextId = 0
  private replies = 0

  constructor(
    spawn: () => WorkerLike,
    private readonly inProcess: InProcessMeta,
    limit = WORKER_JOB_LIMIT
  ) {
    this.queue = new JobQueue(limit, (job) => this.dispatch(job))
    let worker: WorkerLike | null = null
    try {
      worker = spawn()
    } catch {
      worker = null
    }
    this.worker = worker
    worker?.on('message', (reply: SessionWorkerReply) => {
      const entry = this.inFlight.get(reply.id)
      if (!entry) return
      this.inFlight.delete(reply.id)
      this.replies++
      entry.resolve(reply.result)
    })
    worker?.on('error', () => this.failOver())
    worker?.on('exit', () => this.failOver())
  }

  /** Sidebar metadata for one file, parsed off the main thread when the worker is up. */
  meta(agent: AgentKind, path: string, priority: JobPriority): Promise<ConversationMeta | null> {
    return this.queue.run({ kind: 'meta', agent, path }, priority)
  }

  /** Whether jobs still go to the worker (false once it has failed over to in-process parsing). */
  alive(): boolean {
    return this.worker !== null
  }

  /** Replies that came from the worker itself, not the in-process fallback. */
  served(): number {
    return this.replies
  }

  /** Background jobs not yet started — work the caller is still owed. */
  backlog(): number {
    return this.queue.counts().background
  }

  /** Stop the worker; anything it held, and anything later, is parsed in-process. */
  close(): void {
    this.failOver()
  }

  private dispatch(job: SessionJob): Promise<ConversationMeta | null> {
    const worker = this.worker
    if (!worker) return this.runInProcess(job)
    const id = this.nextId++
    return new Promise((resolve) => {
      this.inFlight.set(id, { job, resolve })
      worker.postMessage({ id, job })
    })
  }

  private runInProcess(job: SessionJob): Promise<ConversationMeta | null> {
    return this.inProcess(job.agent, job.path).catch(() => null)
  }

  private failOver(): void {
    const dead = this.worker
    if (!dead) return
    this.worker = null
    void dead.terminate().catch(() => {})
    const held = [...this.inFlight.values()]
    this.inFlight.clear()
    for (const { job, resolve } of held) void this.runInProcess(job).then(resolve)
  }
}
