import type { PtyBindKind } from '../shared/types'

export interface TabRelease {
  sessionId: string
  ownerId: number
}

/** Retire a placeholder claim, but leave the real tab's owner untouched until adoption commits. */
export function retireInitialTabClaim(
  owners: Map<string, number>,
  kind: PtyBindKind,
  oldId: string,
  newId: string,
  pending?: Map<string, number>
): number | null {
  if (kind !== 'initial' || oldId === newId) return null
  const ownerId = owners.get(oldId)
  if (ownerId == null) return null
  owners.delete(oldId)
  pending?.delete(oldId)
  return ownerId
}

interface BoundTabReservation {
  windowId: number
  ptyId: string
  sessionId: string
  /** Initial binds already rekey history globally; corrections retarget only on successful adoption. */
  fromSessionId: string | null
}

/** One outstanding adoption per PTY; consuming a token never changes a later reservation. */
export class BoundTabReservations {
  private readonly entries = new Map<string, BoundTabReservation>()

  reserve(token: string, reservation: BoundTabReservation): void {
    this.discardPty(reservation.ptyId)
    this.entries.set(token, reservation)
  }

  take(token: string, windowId: number): BoundTabReservation | null {
    const reservation = this.entries.get(token)
    if (!reservation || reservation.windowId !== windowId) return null
    this.entries.delete(token)
    return reservation
  }

  discardPty(ptyId: string): void {
    for (const [token, reservation] of this.entries) {
      if (reservation.ptyId === ptyId) this.entries.delete(token)
    }
  }

  discardWindow(windowId: number): void {
    for (const [token, reservation] of this.entries) {
      if (reservation.windowId === windowId) this.entries.delete(token)
    }
  }
}

export interface BoundPtyIdentity {
  ptyId: string
  sessionId: string
}

/** Reserve a corrected tab only when main can prove the sender owns that PTY and identity. */
export function canReserveTabForBoundPty(
  ptyOwners: ReadonlyMap<string, number>,
  ptys: readonly BoundPtyIdentity[],
  windowId: number,
  ptyId: string,
  sessionId: string
): boolean {
  return ptyOwners.get(ptyId) === windowId &&
    ptys.some((pty) => pty.ptyId === ptyId && pty.sessionId === sessionId)
}

/** Reconcile one window's full tab set without allowing a stale report to steal another window's tab. */
export function reconcileWindowTabs(
  owners: Map<string, number>,
  windowId: number,
  sessionIds: readonly string[],
  pending?: Map<string, number>
): TabRelease[] {
  const reported = new Set(sessionIds)
  const next = new Set(reported)
  for (const [sessionId, targetId] of pending ?? []) {
    if (targetId === windowId) next.add(sessionId)
  }
  for (const [sessionId, ownerId] of owners) {
    if (ownerId === windowId && !next.has(sessionId)) owners.delete(sessionId)
  }

  const releases: TabRelease[] = []
  for (const sessionId of next) {
    const ownerId = owners.get(sessionId)
    if (ownerId == null) owners.set(sessionId, windowId)
    else if (ownerId !== windowId) releases.push({ sessionId, ownerId: windowId })
  }
  for (const sessionId of reported) {
    if (pending?.get(sessionId) === windowId) pending.delete(sessionId)
  }
  return releases
}

/** Explicit placement wins immediately and returns the prior owners that must release their tabs. */
export function claimWindowTabs(
  owners: Map<string, number>,
  windowId: number,
  sessionIds: readonly string[],
  pending?: Map<string, number>
): TabRelease[] {
  // No de-duplication needed, unlike `reconcileWindowTabs`: this loop assigns the owner as it goes,
  // so a repeated id finds itself already owned here and cannot emit a second release.
  const releases: TabRelease[] = []
  for (const sessionId of sessionIds) {
    const ownerId = owners.get(sessionId)
    if (ownerId != null && ownerId !== windowId) releases.push({ sessionId, ownerId })
    if (ownerId !== windowId) pending?.set(sessionId, windowId)
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
