/**
 * Pure helpers for the self-updater, kept free of any `electron` import so they're unit-testable under
 * the node tsconfig (the electron-backed glue lives in updater.ts). See updater.ts for the wiring.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { UpdateCheck } from '../shared/types'

/**
 * Walk up from `startDir` looking for this build's SOURCE repo: a `.git` entry alongside a
 * package.json named "switchboard". Returns the repo root, or null if not found within `maxDepth`
 * levels — which is the signal that this copy can't rebuild itself (e.g. the packaged .app was dragged
 * out of its `dist/` folder into /Applications). Pure fs, no electron, so it's unit-testable.
 *
 * In the packaged app, `startDir` is `…/Switchboard.app/Contents/Resources/app.asar`, and the repo is
 * `…/<repo>/dist/mac-arm64/Switchboard.app/…` — six levels up — so the default depth is generous.
 */
export function findRepoRootFrom(startDir: string, maxDepth = 12): string | null {
  let dir = startDir
  for (let i = 0; i < maxDepth; i++) {
    try {
      if (existsSync(join(dir, '.git')) && existsSync(join(dir, 'package.json'))) {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
        if (pkg?.name === 'switchboard') return dir
      }
    } catch {
      /* unreadable package.json / permission — keep walking up */
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Map a GitHub compare of `main...<buildSha>` to an UpdateCheck. Per the compare API, `behind_by` is
 * the number of commits the BASE (main) has that the HEAD (the build) does not — i.e. exactly how many
 * commits the build is behind main. (Verified against the docs + a live API probe.)
 */
export function interpretCompare(behindBy: number): UpdateCheck {
  return behindBy > 0 ? { status: 'behind', behindBy } : { status: 'current' }
}

/**
 * Dev/QA override so every UI state is reachable in `npm run dev`, where the real check can't run (the
 * build commit isn't pushed to the remote). Reads `SWITCHBOARD_FAKE_UPDATE`: 'current' | 'behind[:N]' |
 * 'unknown[:reason]'. Returns null when unset/unrecognized (→ the real check runs). Inert in the
 * packaged app unless the env var is explicitly set.
 */
export function parseFakeUpdate(value: string | undefined): UpdateCheck | null {
  if (!value) return null
  const v = value.trim()
  if (v === 'current') return { status: 'current' }
  if (v.startsWith('behind')) {
    const n = parseInt(v.split(':')[1] ?? '', 10)
    return { status: 'behind', behindBy: Number.isFinite(n) && n > 0 ? n : 1 }
  }
  if (v.startsWith('unknown')) return { status: 'unknown', reason: v.split(':')[1] || 'forced' }
  return null
}
