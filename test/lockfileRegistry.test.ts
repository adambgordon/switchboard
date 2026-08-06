import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Every dependency must resolve from a public host, or `npm ci` fails for any contributor who
// cannot reach the host that was recorded.
//
// This is easy to break without noticing: npm writes the URL it actually fetched from into
// package-lock.json, so whichever registry the installing environment is configured to use is
// what lands there. Adding a dependency is therefore enough to change the set of hosts this
// project depends on, with no source change to review.
//
// An ALLOWLIST, deliberately — not a blocklist of known-bad registries. The risk is not any one
// registry, it is whichever host turns up next. An allowlist catches the ones nobody anticipated.
//
// github.com is legitimate: @electron/node-gyp resolves over git+ssh as a transitive
// dependency of @electron/rebuild. `new URL()` parses that shape fine and yields `github.com`.
const ALLOWED_HOSTS = new Set(['registry.npmjs.org', 'github.com'])

// Resolved relative to THIS FILE rather than process.cwd(), so a different vitest working
// directory cannot make the test read the wrong file — or no file — and quietly pass.
const lockPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package-lock.json')

type Lockfile = { packages?: Record<string, { resolved?: string }> }
const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lockfile

// The root "" entry has no `resolved` (it is this package, not a download). Every other
// entry does.
const resolved = Object.entries(lock.packages ?? {})
  .filter(([, entry]) => Boolean(entry.resolved))
  .map(([path, entry]) => ({ path, url: entry.resolved as string }))

// A malformed `resolved` should read as a clear failure below, not as a thrown URL parse
// error that buries which entry was at fault.
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return `<unparseable: ${url}>`
  }
}

describe('package-lock.json registry hosts', () => {
  it('finds lockfile entries to check', () => {
    // Without this the host check could pass vacuously. A lockfile schema change, a rename,
    // or a broken walk would yield an empty list, and asserting "none of zero entries is
    // bad" is not a guard. The bound is only about non-emptiness — it is deliberately far
    // below the current count (661) so that legitimately dropping dependencies does not
    // fail the suite.
    expect(resolved.length).toBeGreaterThan(100)
  })

  it('resolves every package from a public host', () => {
    const offenders = resolved
      .map(({ path, url }) => ({ path, host: hostOf(url) }))
      .filter(({ host }) => !ALLOWED_HOSTS.has(host))
      .map(({ path, host }) => `${path} -> ${host}`)
    expect(offenders).toEqual([])
  })
})
