/**
 * One cached async value with concurrent sharing and at most one caller-visible trailing refresh.
 *
 * Deliberately not `cachedSingleFlight` (updater-core): that has no trailing pass, so a `force`
 * arriving during a run joins it and returns the result the run had already computed. Here the
 * mid-run request comes from a file watcher, so joining would mean silently dropping the change
 * that triggered it.
 */
export class LatestTask<T> {
  private value: T | undefined
  private hasValue = false
  private inFlight: Promise<T> | null = null
  private refreshAgain = false

  constructor(
    private readonly load: () => Promise<T>,
    private readonly accept?: (value: T) => void
  ) {}

  peek(): T | undefined {
    return this.hasValue ? this.value : undefined
  }

  get(): Promise<T> {
    return this.hasValue ? Promise.resolve(this.value as T) : this.refresh(false)
  }

  refresh(queueIfRunning = true): Promise<T> {
    if (this.inFlight) {
      if (queueIfRunning) this.refreshAgain = true
      return this.inFlight
    }
    const run = async (): Promise<T> => {
      let value!: T
      // At most ONE trailing pass in this promise. A change landing mid-run must not be lost — the
      // watcher event for it IS the `refresh` call, so without a trailing pass it would never be
      // picked up. But looping while changes keep arriving is unbounded, and every caller waiting on
      // `get()` waits for the whole chain: a steady stream of writes can starve the conversation-list
      // IPC for as long as it lasts. Two passes bound that; a change during pass two starts a detached
      // chain after this caller is released.
      for (let pass = 0; pass < 2; pass += 1) {
        this.refreshAgain = false
        value = await this.load()
        this.value = value
        this.hasValue = true
        this.accept?.(value)
        if (!this.refreshAgain) break
      }
      return value
    }
    const current = run().finally(() => {
      if (this.inFlight !== current) return
      this.inFlight = null
      if (this.refreshAgain) {
        this.refreshAgain = false
        void this.refresh(false).catch(() => {})
      }
    })
    this.inFlight = current
    return current
  }
}
