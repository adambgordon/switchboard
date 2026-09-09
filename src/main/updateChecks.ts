import type { UpdateCheck, UpdateCheckState } from '../shared/types'

const CHECK_INTERVAL_MS = 30 * 60 * 1000

interface Flight {
  manual: boolean
  promise: Promise<UpdateCheck>
}

/** One check/deadline for the process, independent of how many windows are subscribed. */
export class UpdateChecks {
  private snapshot: UpdateCheckState = { check: null, checking: false }
  private flight: Flight | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt: number | null = null
  private started = false
  private paused = false
  private disposed = false
  private readonly intervalMs: number
  private readonly periodic: boolean

  constructor(
    private readonly query: () => Promise<UpdateCheck>,
    private readonly publish: (state: UpdateCheckState) => void,
    options: { intervalMs?: number; periodic?: boolean } = {}
  ) {
    this.intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS
    this.periodic = options.periodic ?? true
  }

  get state(): UpdateCheckState {
    return this.snapshot
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    void this.run(false)
  }

  check(force = false): Promise<UpdateCheck> {
    if (!force && !this.flight && this.snapshot.check) return Promise.resolve(this.snapshot.check)
    return this.run(force)
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused || this.disposed) return
    this.paused = paused
    this.clearTimer()
    if (!paused) {
      this.dueAt = Date.now() + this.intervalMs
      this.wake()
    }
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
  }

  private run(manual: boolean): Promise<UpdateCheck> {
    if (this.disposed || this.paused) {
      return Promise.resolve(this.snapshot.check ?? { status: 'unknown', reason: 'check unavailable' })
    }
    if (this.flight) {
      this.flight.manual ||= manual
      return this.flight.promise
    }
    this.clearTimer()
    const flight: Flight = {
      manual,
      promise: Promise.resolve().then(() => {
        if (this.disposed || this.paused) {
          return this.snapshot.check ?? { status: 'unknown' as const, reason: 'check unavailable' }
        }
        return this.query()
      }).catch((error): UpdateCheck => ({
        status: 'unknown', reason: error instanceof Error ? error.message : 'check failed'
      })).then((result) => {
        this.flight = null
        if (this.disposed) return result
        const keepPrevious = !flight.manual && result.status === 'unknown' && this.snapshot.check !== null
        this.snapshot = { check: keepPrevious ? this.snapshot.check : result, checking: false }
        this.dueAt = Date.now() + this.intervalMs
        this.publish(this.snapshot)
        this.wake()
        return result
      })
    }
    this.flight = flight
    this.snapshot = { ...this.snapshot, checking: true }
    this.publish(this.snapshot)
    return flight.promise
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Re-arm the existing deadline; an overdue check runs once on the next event-loop turn. */
  wake(): void {
    this.clearTimer()
    if (!this.started || !this.periodic || this.paused || this.disposed || this.flight || this.dueAt === null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run(false)
    }, Math.max(0, this.dueAt - Date.now()))
    this.timer.unref()
  }
}
