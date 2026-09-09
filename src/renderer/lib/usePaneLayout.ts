import { useCallback, useMemo, useReducer, useRef } from 'react'
import type { PersistedTabLayout, TabOpenMode } from '@shared/types'
import {
  activeTabId,
  initialLayout,
  paneReducer,
  restorePaneLayout,
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
 * Main restores only pane membership/order and the active tab in each pane. Runtime pane ids remain
 * fresh, and Live terminals, preview status, focus and split sizing do not survive a restart.
 */
export interface PaneLayoutApi {
  layout: PaneLayout
  /** The selection — the active tab of the focused pane. */
  selectedId: string | null
  openTab: (sessionId: string, mode: TabOpenMode, opts?: { pane?: number; focus?: boolean }) => void
  openTabs: (sessionIds: string[], activeSessionId: string, pane?: number) => void
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
  moveTabs: (
    sessionIds: string[],
    activeSessionId: string,
    to: { pane: number; index: number }
  ) => void
  splitActiveTab: () => void
  splitPane: () => void
  unsplit: () => void
  focusPane: (index: number) => void
  setSplitFraction: (value: number) => void
  rekeyTabs: (from: string, to: string) => void
  retargetTabs: (from: string, to: string) => void
  restoreLayout: (saved: PersistedTabLayout) => void
  collapseToSingle: () => void
}

export function usePaneLayout(restored?: PersistedTabLayout | null): PaneLayoutApi {
  const [layout, dispatch] = useReducer(
    paneReducer,
    restored,
    (saved) => restorePaneLayout(saved, ['p0', 'p1'])
  )
  // Next unused pane id. Starts at 1 because `initialLayout` took p0.
  const nextPaneId = useRef(layout.panes.length)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const openTab = useCallback(
    (sessionId: string, mode: TabOpenMode, opts?: { pane?: number; focus?: boolean }) =>
      dispatch({ type: 'open', sessionId, mode, pane: opts?.pane, focus: opts?.focus }),
    []
  )
  const openTabs = useCallback(
    (sessionIds: string[], activeSessionId: string, pane?: number) =>
      dispatch({ type: 'openMany', sessionIds, activeSessionId, pane }),
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
    (sessionIds: string[], activeSessionId: string, to: { pane: number; index: number }) =>
      dispatch({ type: 'moveMany', sessionIds, activeSessionId, to }),
    []
  )
  const splitActiveTab = useCallback(() => {
    dispatch({ type: 'splitActive', paneId: `p${nextPaneId.current}` })
    nextPaneId.current += 1
  }, [])
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
  const restoreLayout = useCallback((saved: PersistedTabLayout) => {
    const paneIds = [layoutRef.current.panes[0].id]
    for (let index = 1; index < saved.panes.length; index += 1) {
      paneIds.push(`p${nextPaneId.current}`)
      nextPaneId.current += 1
    }
    dispatch({ type: 'restore', saved, paneIds })
  }, [])
  const collapseToSingle = useCallback(() => dispatch({ type: 'collapseToSingle' }), [])

  const selectedId = useMemo(() => activeTabId(layout), [layout])

  return {
    layout,
    selectedId,
    openTab,
    openTabs,
    promoteTab,
    activateTab,
    deselect,
    closeTab,
    closeOtherTabs,
    closeTabs,
    moveTab,
    moveTabs,
    splitActiveTab,
    splitPane,
    unsplit,
    focusPane,
    setSplitFraction,
    rekeyTabs,
    retargetTabs,
    restoreLayout,
    collapseToSingle
  }
}
