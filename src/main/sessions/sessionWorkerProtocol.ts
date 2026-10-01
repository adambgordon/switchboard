/**
 * Messages between the main process and the session-parsing worker (sessionWorker.ts). One request,
 * exactly one reply, matched by `id`. Jobs are discriminated by `kind` so the worker can take on more
 * kinds of session parsing than sidebar metadata without a second channel.
 */

import type { AgentKind, ConversationMeta } from '../../shared/types'

/** Sidebar metadata for one session file. */
export interface MetaJob {
  kind: 'meta'
  agent: AgentKind
  path: string
}

export type SessionJob = MetaJob

/** What each job kind resolves to. Null means "no metadata" — exactly as the in-process parser. */
export interface SessionJobResult {
  meta: ConversationMeta | null
}

export interface SessionWorkerRequest {
  id: number
  job: SessionJob
}

export interface SessionWorkerReply {
  id: number
  result: SessionJobResult[SessionJob['kind']]
}
