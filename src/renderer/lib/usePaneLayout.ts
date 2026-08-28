import { useCallback, useMemo, useReducer, useRef } from 'react'
import {
  activeTabId,
  initialLayout,
  paneReducer,
  type OpenMode,
  type PaneLayout
} from './paneModel'

/**
 * React binding for the tab / pane model. All of the rules live in `paneReducer`; this only mints
 * pane ids and hands out stable callbacks.
 *
 * Pane ids come from a monotonic counter rather than the array index, and are never recycled. They
 * key terminal ownership (`ptyHome`), so reusing `p1` after an unsplit would hand a brand-new pane
 * the previous occupant's terminals. Minting happens here rather than in the reducer so the reducer
 * stays replayable in a test.
 *
 * Layout state is ephemeral, like the Live order and the navigation history: it does not survive a
 * reload. Live terminals do not either.
 */
export interface PaneLayoutApi {
  layout: PaneLayout
  /** The selection — the active tab of the focused pane. */
  selectedId: string | null
  openTab: (sessionId: string, mode: OpenMode, opts?: { pane?: number; focus?: boolean }) => void
  promoteTab: (sessionId: string, pane?: number) => void
  activateTab: (pane: number, index: number) => void
  /** Show the welcome screen in the focused pane, leaving its tabs alone. */
  deselect: () => void
  closeTab: (pane: number, index: number) => void
  closeOtherTabs: (pane: number, index: number) => void
  moveTab: (from: { pane: number; index: number }, to: { pane: number; index: number }) => void
  /** Bulk forms for a multi-selection, by session id — see the `closeMany` / `moveMany` actions for
   *  why a loop of the single-tab calls above cannot stand in for them. */
  closeTabs: (sessionIds: string[]) => void
  moveTabs: (sessionIds: string[], to: { pane: number; index: number }) => void
  splitPane: () => void
  unsplit: () => void
  focusPane: (index: number) => void
  setSplitFraction: (value: number) => void
  rekeyTabs: (from: string, to: string) => void
  retargetTabs: (from: string, to: string) => void
  collapseToSingle: () => void
}

export function usePaneLayout(): PaneLayoutApi {
  const [layout, dispatch] = useReducer(paneReducer, 'p0', initialLayout)
  // Next unused pane id. Starts at 1 because `initialLayout` took p0.
  const nextPaneId = useRef(1)

  const openTab = useCallback(
    (sessionId: string, mode: OpenMode, opts?: { pane?: number; focus?: boolean }) =>
      dispatch({ type: 'open', sessionId, mode, pane: opts?.pane, focus: opts?.focus }),
    []
  )
  const promoteTab = useCallback(
    (sessionId: string, pane?: number) => dispatch({ type: 'promote', sessionId, pane }),
    []
  )
  const activateTab = useCallback(
    (pane: number, index: number) => dispatch({ type: 'activate', pane, index }),
    []
  )
  const deselect = useCallback(() => dispatch({ type: 'deselect' }), [])
  const closeTab = useCallback(
    (pane: number, index: number) => dispatch({ type: 'close', pane, index }),
    []
  )
  const closeOtherTabs = useCallback(
    (pane: number, index: number) => dispatch({ type: 'closeOthers', pane, index }),
    []
  )
  const moveTab = useCallback(
    (from: { pane: number; index: number }, to: { pane: number; index: number }) =>
      dispatch({ type: 'move', from, to }),
    []
  )
  // Bulk forms for a multi-selection. One dispatch, not a loop: see the action definitions for why
  // closing or moving several tabs cannot be expressed as repeated single-tab calls.
  const closeTabs = useCallback(
    (sessionIds: string[]) => dispatch({ type: 'closeMany', sessionIds }),
    []
  )
  const moveTabs = useCallback(
    (sessionIds: string[], to: { pane: number; index: number }) =>
      dispatch({ type: 'moveMany', sessionIds, to }),
    []
  )
  const splitPane = useCallback(() => {
    dispatch({ type: 'split', paneId: `p${nextPaneId.current}` })
    nextPaneId.current += 1
  }, [])
  const unsplit = useCallback(() => dispatch({ type: 'unsplit' }), [])
  const focusPane = useCallback((index: number) => dispatch({ type: 'focusPane', index }), [])
  const setSplitFraction = useCallback(
    (value: number) => dispatch({ type: 'setSplitFraction', value }),
    []
  )
  const rekeyTabs = useCallback(
    (from: string, to: string) => dispatch({ type: 'rekey', from, to }),
    []
  )
  const retargetTabs = useCallback(
    (from: string, to: string) => dispatch({ type: 'retarget', from, to }),
    []
  )
  const collapseToSingle = useCallback(() => dispatch({ type: 'collapseToSingle' }), [])

  const selectedId = useMemo(() => activeTabId(layout), [layout])

  return {
    layout,
    selectedId,
    openTab,
    promoteTab,
    activateTab,
    deselect,
    closeTab,
    closeOtherTabs,
    closeTabs,
    moveTab,
    moveTabs,
    splitPane,
    unsplit,
    focusPane,
    setSplitFraction,
    rekeyTabs,
    retargetTabs,
    collapseToSingle
  }
}
