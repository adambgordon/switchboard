import type { CopyMode } from './mdCopy'

export interface CopyResult {
  outcome: 'copied' | 'plain-fallback' | 'failed'
  text: string
}

/** Retry serialization, not collection: both attempts must read the same selected content. */
export function copyWithFallback(mode: CopyMode, serialize: (mode: CopyMode) => string): CopyResult {
  try {
    return { outcome: 'copied', text: serialize(mode) }
  } catch {
    if (mode === 'markdown') {
      try {
        return { outcome: 'plain-fallback', text: serialize('plain') }
      } catch {
        // A failed attempt must never contribute partial clipboard data.
      }
    }
    return { outcome: 'failed', text: '' }
  }
}
