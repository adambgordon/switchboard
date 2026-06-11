import { useEffect, useState } from 'react'
import type { ConversationGroup } from '@shared/types'

/** Live-updating conversation index: initial load + watcher-driven re-indexes. */
export function useSessions(): { groups: ConversationGroup[]; loading: boolean } {
  const [groups, setGroups] = useState<ConversationGroup[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    window.api.listConversations().then((g) => {
      if (!alive) return
      setGroups(g)
      setLoading(false)
    })
    const off = window.api.onSessionsChanged((g) => {
      if (alive) setGroups(g)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return { groups, loading }
}
