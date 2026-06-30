/**
 * Self-updater glue. The check resolves `main`'s tip commit via `git ls-remote` over HTTPS (in a login
 * shell) and compares it to the build's baked __GIT_SHA__; the update shells out to the documented
 * `git pull --ff-only <https> main && npm run setup` in the source repo (found by walking up for `.git`),
 * streaming output back, then relaunches into the rebuilt .app. Everything goes through git over HTTPS —
 * never SSH (which `origin` uses and a GUI-spawned `git` can't reliably reach), and never the GitHub REST
 * API (unauthenticated, shared-IP rate-limited — see remoteMainSha / docs/gotchas.md).
 *
 * Pure, unit-tested helpers (repo discovery, SHA comparison, the dev fake) live in updater-core.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import type { UpdateCheck, UpdateInfo, UpdateRunResult } from '../shared/types'
import { findRepoRootFrom, interpretRemoteSha, parseFakeUpdate } from './updater-core'

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
 * Resolve `main`'s tip commit SHA via `git ls-remote` over HTTPS, in a LOGIN shell.
 *
 * NOT the GitHub REST API: that's `api.github.com`, unauthenticated-rate-limited to 60 req/hr PER IP —
 * and behind a shared corporate NAT that pool is drained by everyone's ambient traffic, so the check
 * 403s unpredictably (a public app has no token to raise the limit). git's smart-HTTP transport
 * (`github.com`, not the REST API) isn't subject to that limit. A login shell gives git the PATH +
 * corporate TLS config a GUI app lacks — the same reason runUpdate uses one, and why we avoid hitting
 * the API over node:https (Electron's BoringSSL ignores the corporate CA; see docs/gotchas.md).
 */
function remoteMainSha(): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const child = spawn(shell, ['-lc', `git ls-remote ${REPO_HTTPS} ${BRANCH}`], { env: process.env })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 8000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d: string) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error('timeout'))
        return
      }
      if (code !== 0) {
        reject(new Error(err.trim() || `git ls-remote exited ${code ?? '?'}`))
        return
      }
      const sha = out.split(/\s/)[0] // "<sha>\trefs/heads/main"
      if (/^[0-9a-f]{7,40}$/i.test(sha)) resolve(sha)
      else reject(new Error('no ref'))
    })
  })
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  // Dev/QA: SWITCHBOARD_FAKE_UPDATE forces a result (see updater-core).
  const fake = parseFakeUpdate(process.env.SWITCHBOARD_FAKE_UPDATE)
  if (fake) return fake
  // The real check needs a packaged build whose commit is on the remote; `npm run dev` builds from an
  // unpushed working tree, so report it plainly rather than comparing against a SHA it can't match.
  if (!app.isPackaged) return { status: 'unknown', reason: 'dev' }
  if (buildSha() === 'dev') return { status: 'unknown', reason: 'no build commit' }
  try {
    return interpretRemoteSha(buildSha(), await remoteMainSha())
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
