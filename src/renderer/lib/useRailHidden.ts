import { useCallback, useMemo, useState } from 'react'
import { HIDDEN_FOLDERS_KEY, HIDDEN_ROWS_KEY, parseHiddenSet, withHidden, type UserHidden } from './railFilter'
import { useStorageSync } from './useStorageSync'

/** The conversations and folders the user has hidden, bound to localStorage and followed across windows. */
export interface RailHidden {
  hidden: UserHidden
  setConversationHidden: (id: string, hidden: boolean) => void
  setFolderHidden: (root: string, hidden: boolean) => void
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeKey(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — the choice lasts this run only */
  }
}

const readRows = (): ReadonlySet<string> => parseHiddenSet(readKey(HIDDEN_ROWS_KEY))
const readFolders = (): ReadonlySet<string> => parseHiddenSet(readKey(HIDDEN_FOLDERS_KEY))

export function useRailHidden(): RailHidden {
  const [rows, setRows] = useState<ReadonlySet<string>>(readRows)
  const [folders, setFolders] = useState<ReadonlySet<string>>(readFolders)
  useStorageSync(HIDDEN_ROWS_KEY, readRows, setRows)
  useStorageSync(HIDDEN_FOLDERS_KEY, readFolders, setFolders)

  const setConversationHidden = useCallback((id: string, value: boolean) => {
    const stored = readRows()
    const next = withHidden(stored, id, value)
    if (next !== stored) writeKey(HIDDEN_ROWS_KEY, JSON.stringify([...next]))
    setRows(next)
  }, [])
  const setFolderHidden = useCallback((root: string, value: boolean) => {
    const stored = readFolders()
    const next = withHidden(stored, root, value)
    if (next !== stored) writeKey(HIDDEN_FOLDERS_KEY, JSON.stringify([...next]))
    setFolders(next)
  }, [])

  const hidden = useMemo<UserHidden>(() => ({ rows, folders }), [rows, folders])
  return { hidden, setConversationHidden, setFolderHidden }
}
