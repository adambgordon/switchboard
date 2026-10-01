/**
 * A two-priority job queue with a cap on how many jobs run at once. Pure — no Electron, no workers.
 *
 * The caller decides what runs next, not whatever executes the jobs: only `limit` jobs are ever
 * handed to `start`, so a foreground job queued behind a backlog of background work starts as soon
 * as one slot frees, instead of behind everything already handed off. Foreground always starts
 * before background; within a priority, jobs start in the order they were queued.
 */

export type JobPriority = 'foreground' | 'background'

interface Queued<J, R> {
  job: J
  resolve: (value: R) => void
  reject: (reason: unknown) => void
}

export class JobQueue<J, R> {
  private readonly waiting: Record<JobPriority, Queued<J, R>[]> = { foreground: [], background: [] }
  private running = 0

  constructor(
    private readonly limit: number,
    private readonly start: (job: J) => Promise<R>
  ) {}

  /** Queue `job`; resolves (or rejects) with what `start` produced for it. */
  run(job: J, priority: JobPriority): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.waiting[priority].push({ job, resolve, reject })
      this.pump()
    })
  }

  /** Jobs queued but not started, per priority, and jobs running now. */
  counts(): { foreground: number; background: number; running: number } {
    return {
      foreground: this.waiting.foreground.length,
      background: this.waiting.background.length,
      running: this.running
    }
  }

  private pump(): void {
    while (this.running < this.limit) {
      const next = this.waiting.foreground.shift() ?? this.waiting.background.shift()
      if (!next) return
      this.running++
      let started: Promise<R>
      try {
        started = this.start(next.job)
      } catch (e) {
        started = Promise.reject(e)
      }
      started.then(next.resolve, next.reject).finally(() => {
        this.running--
        this.pump()
      })
    }
  }
}
