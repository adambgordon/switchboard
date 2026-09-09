import type { TabOpenMode } from './types'

export type ConversationView = 'transcript' | 'terminal'

export interface NavigationVisit {
  sessionId: string
  view: ConversationView
}

export interface NavigationCommand {
  requestId: number
  /** The target renderer must not have accepted a newer local navigation since dispatch. */
  targetRevision: number
  sessionId: string
  mode: TabOpenMode
  /** null preserves the destination's remembered view on an ordinary remote reveal. */
  view: ConversationView | null
  kind: 'visit' | 'replay'
}

export function sameVisit(a: NavigationVisit | null, b: NavigationVisit | null): boolean {
  return a === b || (!!a && !!b && a.sessionId === b.sessionId && a.view === b.view)
}
