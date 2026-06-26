import { useCallback, useState } from 'react'

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
 */
const SEEN_KEY = 'switchboard.seenAt'
const UNREAD_KEY = 'switchboard.unreadAt'

function loadMap(key: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function saveMap(key: string, map: Record<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    /* storage unavailable — markers just won't persist this run */
  }
}

export interface Seen {
  /** sessionId -> ms epoch the user last viewed it (selected + focused). */
  seen: Record<string, number>
  /** sessionId -> ms epoch the user manually marked it unread (the solid-dot override). */
  unread: Record<string, number>
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
  const [seen, setSeen] = useState<Record<string, number>>(() => loadMap(SEEN_KEY))
  const [unread, setUnread] = useState<Record<string, number>>(() => loadMap(UNREAD_KEY))

  const markSeen = useCallback((sessionId: string, ts: number) => {
    setSeen((prev) => {
      // Never move a marker backwards; bailing with `prev` also skips a needless re-render.
      if ((prev[sessionId] ?? 0) >= ts) return prev
      const next = { ...prev, [sessionId]: ts }
      saveMap(SEEN_KEY, next)
      return next
    })
  }, [])

  const markUnread = useCallback((sessionId: string) => {
    const ts = Date.now()
    setUnread((prev) => {
      const next = { ...prev, [sessionId]: ts }
      saveMap(UNREAD_KEY, next)
      return next
    })
  }, [])

  const markRead = useCallback((sessionId: string) => {
    const ts = Date.now()
    // Advance the seen marker (forward-only), so the timestamp logic also reads "read".
    setSeen((prev) => {
      if ((prev[sessionId] ?? 0) >= ts) return prev
      const next = { ...prev, [sessionId]: ts }
      saveMap(SEEN_KEY, next)
      return next
    })
    // Drop any manual-unread override.
    setUnread((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      saveMap(UNREAD_KEY, next)
      return next
    })
  }, [])

  const rekey = useCallback((oldId: string, newId: string) => {
    if (oldId === newId) return
    const migrate = (key: string, set: typeof setSeen): void =>
      set((prev) => {
        if (!(oldId in prev)) return prev
        const next = { ...prev, [newId]: prev[oldId] }
        delete next[oldId]
        saveMap(key, next)
        return next
      })
    migrate(SEEN_KEY, setSeen)
    migrate(UNREAD_KEY, setUnread)
  }, [])

  return { seen, unread, markSeen, markUnread, markRead, rekey }
}
