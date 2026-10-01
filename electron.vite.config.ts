import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin, Rollup } from 'vite'

type OutputChunk = Rollup.OutputChunk

const root = import.meta.dirname

/** Name of the fingerprint file written next to the main bundle (read by src/main/ipc.ts). */
const PARSER_FINGERPRINT_FILE = 'session-parser.fingerprint'

/**
 * Write a fingerprint of the session-parsing code: a hash of the bundled worker and every chunk it
 * imports, i.e. exactly the code that produces cached sidebar metadata. The metadata cache is keyed
 * on it, so a build whose parsers changed re-parses, and a build that changed anything else keeps the
 * cache — with no version number for anyone to remember to bump.
 */
function sessionParserFingerprint(): Plugin {
  return {
    name: 'session-parser-fingerprint',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((o): o is OutputChunk => o.type === 'chunk')
      const byFile = new Map(chunks.map((c) => [c.fileName, c]))
      const entry = chunks.find((c) => c.facadeModuleId?.endsWith('/src/main/sessions/sessionWorker.ts'))
      if (!entry) return this.error('session worker chunk not found in the main bundle')
      const hash = createHash('sha256')
      const seen = new Set<string>()
      const visit = (chunk: OutputChunk): void => {
        if (seen.has(chunk.fileName)) return
        seen.add(chunk.fileName)
        hash.update(chunk.code)
        for (const dep of chunk.imports) {
          const next = byFile.get(dep)
          if (next) visit(next)
        }
      }
      visit(entry)
      this.emitFile({ type: 'asset', fileName: PARSER_FINGERPRINT_FILE, source: hash.digest('hex').slice(0, 32) })
    }
  }
}

// The commit this build was packaged from — baked into the main bundle so the updater can ask GitHub
// how many commits `main` is ahead of it (src/main/updater.ts). Computed at build time; 'dev' when not
// a git checkout. Runs for `npm run dev` too (yields the working-tree HEAD, but the in-app update is
// gated to the packaged app regardless).
function buildSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'dev'
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), sessionParserFingerprint()],
    define: { __GIT_SHA__: JSON.stringify(buildSha()) },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve(root, 'src/renderer'),
        '@shared': resolve(root, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
