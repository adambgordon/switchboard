// Rebuild native modules (node-pty) against the installed Electron's ABI.
// We call @electron/rebuild's programmatic API directly because its yargs-based
// CLI breaks under Node 26's stricter ESM loader.
import { rebuild } from '@electron/rebuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronVersion = require('electron/package.json').version

console.log(`Rebuilding node-pty for Electron ${electronVersion} (${process.arch})…`)
await rebuild({
  buildPath: projectDir,
  electronVersion,
  arch: process.arch,
  onlyModules: ['node-pty'],
  force: true
})
console.log('✓ node-pty rebuilt for Electron', electronVersion)
