/**
 * Self-updater glue. The check compares the build's commit (baked as __GIT_SHA__ by electron.vite.config)
 * to the latest on `main` via the GitHub compare API — over HTTPS, unauthenticated (the repo is public),
 * so it never touches SSH (which `origin` uses and which a GUI-spawned `git` can't reliably reach). The
 * update shells out to the documented `git pull --ff-only <https> main && npm run setup` in the source
 * repo (found by walking up for `.git`), streaming output back, then relaunches into the rebuilt .app.
 *
 * Pure, unit-tested helpers (repo discovery, compare interpretation, the dev fake) live in updater-core.
 */
import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import type { UpdateCheck, UpdateInfo, UpdateRunResult } from '../shared/types'
import { findRepoRootFrom, interpretCompare, parseFakeUpdate } from './updater-core'

// Replaced at build time by electron.vite.config's `define`; 'dev' when the config couldn't read git.
declare const __GIT_SHA__: string

const OWNER = 'adambgordon'
const REPO = 'switchboard'
const BRANCH = 'main'
const REPO_HTTPS = `https://github.com/${OWNER}/${REPO}.git`

function buildSha(): string {
  return typeof __GIT_SHA__ === 'string' && __GIT_SHA__ ? __GIT_SHA__ : 'dev'
}

function repoRoot(): string | null {
  return findRepoRootFrom(app.getAppPath())
}

export function buildInfo(): UpdateInfo {
  const sha = buildSha()
  return {
    version: app.getVersion(),
    sha,
    shaShort: sha === 'dev' ? 'dev' : sha.slice(0, 7),
    repoRoot: repoRoot(),
    packaged: app.isPackaged
  }
}

/**
 * GitHub compare `main...<head>` → `behind_by` (commits the head is behind main). Unauthenticated.
 *
 * Uses Electron's `net` (Chromium's network stack), NOT `node:https`. On a TLS-inspecting corporate
 * network — a firewall that re-signs api.github.com with an internal root CA — `node:https` fails with
 * SELF_SIGNED_CERT_IN_CHAIN: Electron's Node is backed by BoringSSL, which trusts only its bundled
 * Mozilla CA set and ignores the SSL_CERT_FILE / NODE_EXTRA_CA_CERTS that make system tools work (and a
 * GUI app wouldn't inherit those env vars regardless). `net` uses the OS trust store + system proxy, like
 * curl / Chrome / git already do on the machine. `net` has no `timeout` option, so we abort on a manual timer.
 */
function githubBehindBy(head: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url: `https://api.github.com/repos/${OWNER}/${REPO}/compare/${BRANCH}...${encodeURIComponent(head)}`
    })
    req.setHeader('User-Agent', 'Switchboard')
    req.setHeader('Accept', 'application/vnd.github+json')
    const timer = setTimeout(() => req.abort(), 8000)
    req.on('response', (res) => {
      let body = ''
      res.on('data', (c) => (body += c.toString()))
      res.on('end', () => {
        clearTimeout(timer)
        const code = res.statusCode
        if (code && code >= 200 && code < 300) {
          try {
            const json = JSON.parse(body) as { behind_by?: number }
            resolve(typeof json.behind_by === 'number' ? json.behind_by : 0)
          } catch {
            reject(new Error('bad response'))
          }
        } else {
          reject(new Error(`HTTP ${code ?? '?'}`))
        }
      })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.on('abort', () => reject(new Error('timeout')))
    req.end()
  })
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  // Dev/QA: SWITCHBOARD_FAKE_UPDATE forces a result (see updater-core).
  const fake = parseFakeUpdate(process.env.SWITCHBOARD_FAKE_UPDATE)
  if (fake) return fake
  // The real check needs a packaged build whose commit is on the remote; `npm run dev` builds from an
  // unpushed working tree, so report it plainly rather than 404ing against the compare API.
  if (!app.isPackaged) return { status: 'unknown', reason: 'dev' }
  if (buildSha() === 'dev') return { status: 'unknown', reason: 'no build commit' }
  try {
    return interpretCompare(await githubBehindBy(buildSha()))
  } catch (e) {
    return { status: 'unknown', reason: e instanceof Error ? e.message : 'check failed' }
  }
}

/**
 * Run the documented update in the source repo, streaming each output line to `onProgress`. Pulls over
 * HTTPS (public repo → no SSH/auth) and `--ff-only` so a dirty/diverged tree fails cleanly instead of
 * creating a merge; then `npm run setup` (deps + node-pty rebuild + electron-builder package). Spawns a
 * LOGIN shell so git/npm are on PATH (a GUI app's own PATH is minimal — same reason the terminal does).
 * Resolves ok=false on any failure, or immediately in a dev run (the build only makes sense packaged).
 */
export function runUpdate(onProgress: (line: string) => void): Promise<UpdateRunResult> {
  if (!app.isPackaged) {
    onProgress('Updates run only in the packaged app, not in `npm run dev`.\n')
    return Promise.resolve({ ok: false, code: null })
  }
  const root = repoRoot()
  if (!root) {
    onProgress('Could not find this app’s source repo — update manually instead.\n')
    return Promise.resolve({ ok: false, code: null })
  }
  const shell = process.env.SHELL || '/bin/zsh'
  const script = [
    'set -e',
    'echo "» Pulling latest from main…"',
    `git pull --ff-only ${REPO_HTTPS} ${BRANCH}`,
    'echo "» Building (this takes a minute or two)…"',
    'npm run setup',
    'echo "» Done — reopen to finish."'
  ].join('\n')
  const child = spawn(shell, ['-lc', script], { cwd: root, env: process.env })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d: string) => onProgress(d))
  child.stderr.on('data', (d: string) => onProgress(d))
  return new Promise((resolve) => {
    child.on('error', (err) => {
      onProgress(`\n✖ ${err.message}\n`)
      resolve({ ok: false, code: null })
    })
    child.on('close', (code) => resolve({ ok: code === 0, code }))
  })
}

/** Relaunch into the rebuilt bundle. process.execPath points inside the .app, which the repackage just
 *  overwrote in place, so the relaunched process loads the new build. */
export function relaunchForUpdate(): void {
  app.relaunch()
  app.quit()
}
