import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const root = import.meta.dirname

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
    plugins: [externalizeDepsPlugin()],
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
