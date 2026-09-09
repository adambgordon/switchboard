import type { PtySnapshot } from '../../shared/types'

export interface PtyTransferOps {
  pause: () => void
  resume: () => void
  capture: () => Promise<PtySnapshot | null>
  stage: (snapshot: PtySnapshot) => boolean
  commit: () => void
  repaintUnowned: () => void
}

/**
 * Ordered ownership transfer: the snapshot is DELIVERED to the destination before the owner
 * changes, and a failure to deliver aborts without moving ownership.
 *
 * Not transactional in the stronger sense — `stage` reports that the destination accepted the
 * snapshot, not that it rebuilt the terminal from it, so a restore that goes wrong after a
 * successful stage still commits. That is deliberate: the alternative is leaving a live terminal
 * owned by a window that has already stopped rendering it. The repaint nudge at the end is what
 * recovers a destination whose restore came out imperfect.
 */
export async function transferPty(
  ownerId: number | undefined,
  targetId: number,
  ops: PtyTransferOps
): Promise<boolean> {
  if (ownerId === targetId) return true
  if (ownerId == null) {
    ops.commit()
    ops.repaintUnowned()
    return true
  }
  ops.pause()
  try {
    const snapshot = await ops.capture()
    if (!snapshot || !ops.stage(snapshot)) return false
    ops.commit()
    return true
  } finally {
    ops.resume()
  }
}
