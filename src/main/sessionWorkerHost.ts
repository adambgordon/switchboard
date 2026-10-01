/// <reference types="electron-vite/node" />
/**
 * Where the session-parsing worker is created. electron-vite bundles `sessionWorker.ts` as its own
 * worker entry through the `?nodeWorker` import, so this is the one module that knows about the
 * bundler; everything else takes a `spawn` function (see SessionWorkerClient).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import createSessionWorker from './sessions/sessionWorker?nodeWorker'
import type { WorkerLike } from './sessions/sessionWorkerClient'

export function spawnSessionWorker(): WorkerLike {
  return createSessionWorker({}) as unknown as WorkerLike
}

/**
 * The parser fingerprint the build wrote next to the main bundle (electron.vite.config.ts), or null
 * when it is missing — in which case nothing cached on disk is trusted as current.
 */
export function readParserFingerprint(): string | null {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), 'session-parser.fingerprint')
    return readFileSync(file, 'utf8').trim() || null
  } catch {
    return null
  }
}
