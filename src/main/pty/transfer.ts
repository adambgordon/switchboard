import type { PtySnapshot } from '../../shared/types'

export interface PtyTransferOps {
  pause: () => void
  resume: () => void
  capture: () => Promise<PtySnapshot | null>
  stage: (snapshot: PtySnapshot) => boolean
  commit: () => void
  repaintUnowned: () => void
}

/** Transactional ownership transfer: state reaches the destination before the owner changes. */
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
