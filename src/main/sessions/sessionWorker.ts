/**
 * Worker-thread entry for session parsing, so the main thread — which also routes every input event
 * to the window — never blocks on a large file. Runs the same parsers the index uses in-process;
 * moving work here changes where the CPU is spent and nothing else. Every request gets exactly one
 * reply, and a parser failure replies null, like the index's own safe wrappers.
 */

import { parentPort } from 'node:worker_threads'
import type { ConversationMeta } from '../../shared/types'
import { extractMeta } from './parser'
import { extractCodexMeta } from './codexParser'
import type { SessionJob, SessionWorkerReply, SessionWorkerRequest } from './sessionWorkerProtocol'

async function run(job: SessionJob): Promise<ConversationMeta | null> {
  try {
    return job.agent === 'claude' ? await extractMeta(job.path) : await extractCodexMeta(job.path)
  } catch {
    return null
  }
}

parentPort?.on('message', (request: SessionWorkerRequest) => {
  void run(request.job).then((result) => {
    const reply: SessionWorkerReply = { id: request.id, result }
    parentPort?.postMessage(reply)
  })
})
