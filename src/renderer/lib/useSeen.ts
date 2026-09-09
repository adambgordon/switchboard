import { useCallback, useEffect, useState } from 'react'
import { advanceMark, clearMark, rekeyMark, setMark, type Marks } from './marks'

/**
 * Per-conversation read/unread state, persisted in localStorage (renderer state; survives
 * restarts). Two maps:
 *
 *  - `seen` — ms epoch the user last viewed a conversation (selected + window focused).
 *    Compared against a session's `turnEndedAt` to tell "finished, not yet seen" (awaiting)
 *    from "seen" (quiet). Only ever advances forward.
 *  - `unread` — a *manual* override: sessionId -> the ms epoch the user marked it unread.
 *    Forces the solid dot regardless of `seen`/`lookingNow`. It auto-expires once a *new*
 *    turn lands (the caller compares `turnEndedAt > markedAt`), handing back to the `seen`
 *    logic, and is cleared outright by `markRead` (an explicit toggle, or selecting it).
 *
 * EVERY WINDOW SHARES THIS STORE, and none of them is the owner. Two consequences shape the code
 * below. Mutations are applied to what is on DISK, not to what this window last rendered: each one
 * re-reads, folds in a single change, and writes back — so a window can no longer revert changes it
 * never saw. (It previously serialised its whole in-memory map, which meant one window's save undid
 * every marker another had touched since it loaded, not just the one they disagreed about.) And a
 * `storage` subscription keeps the rendered copy current when another window writes, so two windows
 * do not sit showing different dots for the same conversation.
 *
 * What remains is two windows writing in the same instant, where one loses — bounded to the single
 * conversation they raced on, and self-correcting on the next act. Serialising through the main
 * process would close even that, at the price of an IPC round trip on a first-paint path.
 */
const SEEN_KEY = 'switchboard.seenAt'
const UNREAD_KEY = 'switchboard.unreadAt'

function loadMap(key: string): Marks {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Marks = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function saveMap(key: string, map: Marks): void {
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    /* storage unavailable — markers just won't persist this run */
  }
}

export interface Seen {
  /** sessionId -> ms epoch the user last viewed it (selected + focused). */
  seen: Marks
  /** sessionId -> ms epoch the user manually marked it unread (the solid-dot override). */
  unread: Marks
  /** Record that `sessionId` was seen at `ts`. Only ever advances forward. */
  markSeen: (sessionId: string, ts: number) => void
  /** Manually mark a conversation unread as of now (forces the solid dot). */
  markUnread: (sessionId: string) => void
  /** Force a conversation to read: clear any manual-unread flag AND advance its seen marker. */
  markRead: (sessionId: string) => void
  /** Migrate a session's markers from `oldId` to `newId` (a new-Codex bind swaps the placeholder id
   *  for the real one). No-op when there's nothing stored under `oldId`. */
  rekey: (oldId: string, newId: string) => void
}

export function useSeen(): Seen {
  const [seen, setSeen] = useState<Marks>(() => loadMap(SEEN_KEY))
  const [unread, setUnread] = useState<Marks>(() => loadMap(UNREAD_KEY))

  /**
   * Apply one change to the stored map and adopt the result.
   *
   * `fn` is handed what is ON DISK, not React's copy — that is the whole point. The merge helpers
   * return their input by identity when nothing changes, so an unchanged result skips both the write
   * and the re-render; and when it DOES change, the state we adopt already includes whatever other
   * windows had written.
   */
  const mutate = useCallback(
    (key: string, set: (m: Marks) => void, fn: (stored: Marks) => Marks): void => {
      const stored = loadMap(key)
      const next = fn(stored)
      if (next === stored) {
        // Nothing to persist. Still adopt the fresh read: another window may have moved this marker,
        // and that is the reason our own change was a no-op.
        set(stored)
        return
      }
      saveMap(key, next)
      set(next)
    },
    []
  )

  // Another window wrote. Re-read rather than merge: it has already folded its change into what is on
  // disk, so disk is the newer truth. A null `key` means the whole area was cleared.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === SEEN_KEY) setSeen(loadMap(SEEN_KEY))
      if (e.key === null || e.key === UNREAD_KEY) setUnread(loadMap(UNREAD_KEY))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const markSeen = useCallback(
    (sessionId: string, ts: number) => {
      mutate(SEEN_KEY, setSeen, (m) => advanceMark(m, sessionId, ts))
    },
    [mutate]
  )

  const markUnread = useCallback(
    (sessionId: string) => {
      const ts = Date.now()
      mutate(UNREAD_KEY, setUnread, (m) => setMark(m, sessionId, ts))
    },
    [mutate]
  )

  const markRead = useCallback(
    (sessionId: string) => {
      const ts = Date.now()
      // Advance the seen marker (forward-only), so the timestamp logic also reads "read".
      mutate(SEEN_KEY, setSeen, (m) => advanceMark(m, sessionId, ts))
      // Drop any manual-unread override.
      mutate(UNREAD_KEY, setUnread, (m) => clearMark(m, sessionId))
    },
    [mutate]
  )

  const rekey = useCallback(
    (oldId: string, newId: string) => {
      mutate(SEEN_KEY, setSeen, (m) => rekeyMark(m, oldId, newId))
      mutate(UNREAD_KEY, setUnread, (m) => rekeyMark(m, oldId, newId))
    },
    [mutate]
  )

  return { seen, unread, markSeen, markUnread, markRead, rekey }
}
