import { useCallback, useState } from 'react'
import { FOLDER_RANK_KEY, ROW_RANK_KEY, parseRanks, type RankOverrides } from './rowRank'
import { useStorageSync } from './useStorageSync'

/**
 * The rail's sparse rank overrides — rows in `switchboard.rowRank`, folders in
 * `switchboard.folderRank` — shared by every window. See `rowRank` for the model.
 *
 * Each change is a function of what is ON DISK, not of this window's copy: the maps are single values
 * shared across windows, so writing this window's stale copy back would undo another window's drag.
 * Re-read, fold in the change, write back — `usePins`' discipline, and exact here because a change
 * touches one key. Nothing is written on mount or on a catalog change; only the events `rowRank` lists
 * (a drop, a Resume, a bind, a first-index hold) call these.
 */
export interface RowRank {
  rows: RankOverrides
  folders: RankOverrides
  /** Apply `fn` to the stored row overrides. Returning its input unchanged writes nothing. */
  mutateRows: (fn: (stored: RankOverrides) => RankOverrides) => void
  mutateFolders: (fn: (stored: RankOverrides) => RankOverrides) => void
}

function read(key: string): Record<string, number> {
  try {
    return parseRanks(localStorage.getItem(key))
  } catch {
    return {}
  }
}

const readRows = (): Record<string, number> => read(ROW_RANK_KEY)
const readFolders = (): Record<string, number> => read(FOLDER_RANK_KEY)

function useRankStore(
  key: string,
  load: () => Record<string, number>
): [RankOverrides, (fn: (stored: RankOverrides) => RankOverrides) => void] {
  const [value, setValue] = useState<RankOverrides>(load)
  useStorageSync<RankOverrides>(key, load, setValue)
  const mutate = useCallback(
    (fn: (stored: RankOverrides) => RankOverrides) => {
      const stored = load()
      const next = fn(stored)
      if (next !== stored) {
        try {
          localStorage.setItem(key, JSON.stringify(next))
        } catch {
          /* storage unavailable — the move lasts this run only */
        }
      }
      // Adopt the fresh read even on a no-op: it may carry another window's change.
      setValue(next)
    },
    [key, load]
  )
  return [value, mutate]
}

export function useRowRank(): RowRank {
  const [rows, mutateRows] = useRankStore(ROW_RANK_KEY, readRows)
  const [folders, mutateFolders] = useRankStore(FOLDER_RANK_KEY, readFolders)
  return { rows, folders, mutateRows, mutateFolders }
}
