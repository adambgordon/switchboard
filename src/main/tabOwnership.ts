export interface TabRelease {
  sessionId: string
  ownerId: number
}

/** Reconcile one window's full tab set without allowing a stale report to steal another window's tab. */
export function reconcileWindowTabs(
  owners: Map<string, number>,
  windowId: number,
  sessionIds: readonly string[]
): TabRelease[] {
  const next = new Set(sessionIds)
  for (const [sessionId, ownerId] of owners) {
    if (ownerId === windowId && !next.has(sessionId)) owners.delete(sessionId)
  }

  const releases: TabRelease[] = []
  for (const sessionId of next) {
    const ownerId = owners.get(sessionId)
    if (ownerId == null) owners.set(sessionId, windowId)
    else if (ownerId !== windowId) releases.push({ sessionId, ownerId: windowId })
  }
  return releases
}

/** Explicit placement wins immediately and returns the prior owners that must release their tabs. */
export function claimWindowTabs(
  owners: Map<string, number>,
  windowId: number,
  sessionIds: readonly string[]
): TabRelease[] {
  const releases: TabRelease[] = []
  for (const sessionId of new Set(sessionIds)) {
    const ownerId = owners.get(sessionId)
    if (ownerId != null && ownerId !== windowId) releases.push({ sessionId, ownerId })
    owners.set(sessionId, windowId)
  }
  return releases
}

/** A queued release remains valid only while another window still owns the tab. */
export function shouldReleaseTab(
  owners: ReadonlyMap<string, number>,
  windowId: number,
  sessionId: string
): boolean {
  const ownerId = owners.get(sessionId)
  return ownerId != null && ownerId !== windowId
}
