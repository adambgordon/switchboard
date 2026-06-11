import Fuse from 'fuse.js'
import type { ConversationMeta } from '@shared/types'

/** Fuzzy-rank conversations by title, preview, and cwd. Empty query → identity. */
export function searchConversations(all: ConversationMeta[], query: string): ConversationMeta[] {
  const q = query.trim()
  if (!q) return all
  const fuse = new Fuse(all, {
    keys: [
      { name: 'title', weight: 0.6 },
      { name: 'preview', weight: 0.25 },
      { name: 'cwd', weight: 0.15 }
    ],
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2
  })
  return fuse.search(q).map((r) => r.item)
}
