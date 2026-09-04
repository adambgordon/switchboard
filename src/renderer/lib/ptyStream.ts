import type { PtySnapshot } from '../../shared/types'

type Writer = (data: string, done: () => void) => void

interface Attachment {
  writer: Writer
  snapshot: () => PtySnapshot
  restored?: (snapshot: PtySnapshot) => void
  dispatchedThrough: number
}

interface PendingChunk {
  seq: number
  data: string
}

interface StreamState {
  pending: PendingChunk[]
  units: number
  nextSeq: number
  snapshot: PtySnapshot | null
  attachment: Attachment | null
  restoring: boolean
  paused: boolean
  drainWaiters: Array<(snapshot: PtySnapshot | null) => void>
}

declare const window: {
  api: {
    onPtyData: (cb: (id: string, data: string) => void) => () => void
    setPtyOutputPaused: (id: string, paused: boolean) => void
    onPtySnapshotRequest: (cb: (requestId: string, ptyId: string) => void) => () => void
    replyPtySnapshot: (requestId: string, ptyId: string, snapshot: PtySnapshot | null) => void
    onPtySnapshotStage: (cb: (ptyId: string, snapshot: PtySnapshot) => void) => () => void
  }
}

const HIGH_WATER_UNITS = 256 * 1024
const LOW_WATER_UNITS = HIGH_WATER_UNITS / 2

const streams = new Map<string, StreamState>()
let started = false

function streamFor(id: string): StreamState {
  const found = streams.get(id)
  if (found) return found
  const created: StreamState = {
    pending: [],
    units: 0,
    nextSeq: 0,
    snapshot: null,
    attachment: null,
    restoring: false,
    paused: false,
    drainWaiters: []
  }
  streams.set(id, created)
  return created
}

function syncFlow(id: string, state: StreamState): void {
  if (!state.paused && state.units >= HIGH_WATER_UNITS) {
    state.paused = true
    window.api.setPtyOutputPaused(id, true)
  } else if (state.paused && state.units <= LOW_WATER_UNITS) {
    state.paused = false
    window.api.setPtyOutputPaused(id, false)
  }
}

function resolveDrains(state: StreamState): void {
  if (state.restoring || state.pending.length > 0 || state.drainWaiters.length === 0) return
  const snapshot = state.attachment?.snapshot() ?? state.snapshot
  const waiters = state.drainWaiters.splice(0)
  for (const resolve of waiters) resolve(snapshot)
}

function acknowledge(id: string, state: StreamState, attachment: Attachment, seq: number): void {
  if (state.attachment !== attachment) return
  let removed = 0
  while (removed < state.pending.length && state.pending[removed].seq <= seq) {
    state.units -= state.pending[removed].data.length
    removed += 1
  }
  if (removed > 0) state.pending.splice(0, removed)
  syncFlow(id, state)
  resolveDrains(state)
}

function deliverPending(id: string, state: StreamState, attachment: Attachment): void {
  if (state.attachment !== attachment || state.restoring) return
  for (const chunk of [...state.pending]) {
    if (chunk.seq <= attachment.dispatchedThrough) continue
    attachment.dispatchedThrough = chunk.seq
    attachment.writer(chunk.data, () => acknowledge(id, state, attachment, chunk.seq))
  }
}

function ensureStarted(): void {
  if (started) return
  started = true
  window.api.onPtyData((id, data) => {
    const state = streamFor(id)
    const chunk = { seq: state.nextSeq++, data }
    state.pending.push(chunk)
    state.units += data.length
    syncFlow(id, state)
    if (state.attachment) deliverPending(id, state, state.attachment)
  })
  window.api.onPtySnapshotRequest((requestId, ptyId) => {
    void capturePtySnapshot(ptyId).then((snapshot) => {
      window.api.replyPtySnapshot(requestId, ptyId, snapshot)
    })
  })
  window.api.onPtySnapshotStage((ptyId, snapshot) => stagePtySnapshot(ptyId, snapshot))
}

export function initPtyStream(): void {
  ensureStarted()
}

/** Inspect the staged geometry before constructing the replacement xterm. */
export function pendingPtySnapshot(id: string): PtySnapshot | null {
  return streams.get(id)?.snapshot ?? null
}

/**
 * Attach one xterm. Serialized state is written first; output that arrived after it follows only once
 * xterm acknowledges the restore, so a move has one ordered stream rather than snapshot/tail races.
 */
export function attachPty(
  id: string,
  writer: Writer,
  snapshot: () => PtySnapshot,
  restored?: (snapshot: PtySnapshot) => void
): () => void {
  ensureStarted()
  const state = streamFor(id)
  const attachment: Attachment = {
    writer,
    snapshot,
    restored,
    dispatchedThrough: state.pending[0]?.seq != null ? state.pending[0].seq - 1 : state.nextSeq - 1
  }
  state.attachment = attachment
  const staged = state.snapshot
  if (staged) {
    state.restoring = true
    writer(staged.data, () => {
      if (state.attachment !== attachment) return
      state.snapshot = null
      state.restoring = false
      attachment.restored?.(staged)
      deliverPending(id, state, attachment)
      resolveDrains(state)
    })
  } else {
    deliverPending(id, state, attachment)
  }

  return () => {
    if (state.attachment !== attachment) return
    state.attachment = null
    state.restoring = false
    for (const resolve of state.drainWaiters.splice(0)) resolve(null)
  }
}

/** Capture after every delivered write has reached xterm. Main pauses the PTY before requesting this. */
export function capturePtySnapshot(id: string): Promise<PtySnapshot | null> {
  ensureStarted()
  const state = streams.get(id)
  if (!state) return Promise.resolve(null)
  if (!state.attachment) return Promise.resolve(state.snapshot)
  if (!state.restoring && state.pending.length === 0) {
    return Promise.resolve(state.attachment.snapshot())
  }
  return new Promise((resolve) => state.drainWaiters.push(resolve))
}

/** Main sends this before the ownership update that mounts the destination TerminalView. */
export function stagePtySnapshot(id: string, snapshot: PtySnapshot): void {
  const state = streamFor(id)
  state.snapshot = snapshot
  state.pending = []
  state.units = 0
  state.nextSeq = 0
  syncFlow(id, state)
}

export function retainOnly(liveIds: Set<string>): void {
  for (const [id, state] of streams) {
    if (liveIds.has(id)) continue
    if (state.paused) window.api.setPtyOutputPaused(id, false)
    for (const resolve of state.drainWaiters) resolve(null)
    streams.delete(id)
  }
}
