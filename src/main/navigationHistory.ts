import { sameVisit, type NavigationVisit } from '../shared/navigation'

export interface NavigationHistory {
  entries: NavigationVisit[]
  cursor: number
  away: boolean
}

export type HistoryAction =
  | { type: 'visit'; visit: NavigationVisit }
  | { type: 'home' }
  | { type: 'step'; direction: -1 | 1 }
  | { type: 'rekey'; from: string; to: string }
  | { type: 'retarget'; from: string; to: string }

export const EMPTY_HISTORY: NavigationHistory = { entries: [], cursor: -1, away: true }

/** One process-wide log of visits. Playback moves the cursor without recording a new visit. */
export function historyReducer(state: NavigationHistory, action: HistoryAction): NavigationHistory {
  switch (action.type) {
    case 'visit': {
      if (sameVisit(state.entries[state.cursor] ?? null, action.visit)) {
        return state.away ? { ...state, away: false } : state
      }
      const entries = [...state.entries.slice(0, state.cursor + 1), action.visit]
      return { entries, cursor: entries.length - 1, away: false }
    }
    case 'home':
      return state.away ? state : { ...state, away: true }
    case 'step': {
      if (state.cursor < 0 || (state.away && action.direction === 1)) return state
      const cursor = state.away
        ? state.cursor
        : Math.max(0, Math.min(state.entries.length - 1, state.cursor + action.direction))
      return cursor === state.cursor && !state.away ? state : { ...state, cursor, away: false }
    }
    case 'rekey': {
      if (action.from === action.to || !state.entries.some((v) => v.sessionId === action.from)) return state
      return {
        ...state,
        entries: state.entries.map((v) => v.sessionId === action.from ? { ...v, sessionId: action.to } : v)
      }
    }
    case 'retarget': {
      const current = state.entries[state.cursor]
      if (state.away || !current || current.sessionId !== action.from || action.from === action.to) return state
      return {
        ...state,
        entries: state.entries.map((v, i) => i === state.cursor ? { ...v, sessionId: action.to } : v)
      }
    }
  }
}
