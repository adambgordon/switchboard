import type { AgentKind, Transcript } from '../shared/types'

export interface TranscriptSource {
  agent: AgentKind
  path: string
}

/** Cache stable session paths and share only in-flight parses for the same file revision. */
export class TranscriptLoader {
  private readonly sources = new Map<string, TranscriptSource>()
  private readonly loads = new Map<string, Promise<Transcript | null>>()

  constructor(
    private readonly resolveSource: (sessionId: string) => Promise<TranscriptSource | null>,
    private readonly parseSource: (source: TranscriptSource) => Promise<Transcript | null>
  ) {}

  load(sessionId: string, revision: string): Promise<Transcript | null> {
    const key = `${sessionId}\0${revision}`
    const found = this.loads.get(key)
    if (found) return found
    const current = (async () => {
      let source = this.sources.get(sessionId)
      if (!source) {
        source = await this.resolveSource(sessionId) ?? undefined
        if (!source) return null
        this.sources.set(sessionId, source)
      }
      try {
        return await this.parseSource(source)
      } catch {
        return null
      }
    })().finally(() => {
      if (this.loads.get(key) === current) this.loads.delete(key)
    })
    this.loads.set(key, current)
    return current
  }
}
