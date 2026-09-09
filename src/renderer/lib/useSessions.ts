import { useEffect, useMemo, useState } from 'react'
import { EMPTY_SESSION_INDEX } from '@shared/sessionVisibility'
import { startSnapshotSync } from './snapshotSync'

/** Live-updating conversation index: initial load + watcher-driven re-indexes. */
export function useSessions() {
  const [snapshot, setSnapshot] = useState(EMPTY_SESSION_INDEX)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    return startSnapshotSync(window.api.onSessionsChanged, window.api.listConversations, (value) => {
      setSnapshot(value)
      setLoading(false)
    })
  }, [])

  const hiddenKey = JSON.stringify(snapshot.hiddenSessionIds)
  const hiddenSessionIds = useMemo<ReadonlySet<string>>(() => new Set(JSON.parse(hiddenKey)), [hiddenKey])
  return { groups: snapshot.groups, hiddenSessionIds, loading }
}
