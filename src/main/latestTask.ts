/** One cached async value with concurrent sharing and one trailing refresh when work changes mid-run. */
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
      do {
        this.refreshAgain = false
        value = await this.load()
        this.value = value
        this.hasValue = true
        this.accept?.(value)
      } while (this.refreshAgain)
      return value
    }
    const current = run().finally(() => {
      if (this.inFlight === current) this.inFlight = null
    })
    this.inFlight = current
    return current
  }
}
