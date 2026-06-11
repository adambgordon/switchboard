// One-shot setup: from a fresh clone to a built Switchboard.app.
// Installs dependencies, rebuilds the node-pty native module for Electron's ABI,
// packages the macOS app, and prints where it landed. Run with `npm run setup`.
// Uses only Node built-ins, so it works on a fresh clone before `npm install`.
import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// macOS only — the app is macOS-first and the packaging target is mac.
if (process.platform !== 'darwin') {
  console.error('✗ Switchboard is macOS-only; setup must run on macOS.')
  process.exit(1)
}

// Preflight: node-pty compiles native code, which needs the Xcode Command Line Tools.
// Fail fast with the exact fix rather than deep inside a compiler error.
try {
  execSync('xcode-select -p', { stdio: 'ignore' })
} catch {
  console.error('✗ Xcode Command Line Tools are required to build node-pty.')
  console.error('  Install them, then re-run `npm run setup`:\n')
  console.error('      xcode-select --install\n')
  process.exit(1)
}

const step = (label, cmd) => {
  console.log(`\n▸ ${label}…`)
  try {
    execSync(cmd, { cwd: projectDir, stdio: 'inherit' })
  } catch {
    console.error(`\n✗ Setup failed during: ${label}`)
    console.error('  See the output above, fix the issue, and re-run `npm run setup`.')
    process.exit(1)
  }
}

step('Installing dependencies', 'npm install')
step('Rebuilding node-pty for Electron', 'npm run rebuild')
step('Packaging the macOS app', 'npm run package')

// electron-builder emits dist/mac/ (Intel) or dist/mac-arm64/ (Apple Silicon) — find whichever.
const distDir = join(projectDir, 'dist')
const macDir = existsSync(distDir)
  ? readdirSync(distDir).find(
      (d) => d.startsWith('mac') && existsSync(join(distDir, d, 'Switchboard.app'))
    )
  : undefined
const appPath = macDir ? join(distDir, macDir, 'Switchboard.app') : null

console.log('\n✓ Setup complete.\n')
if (appPath) {
  console.log(`  Built: ${appPath}\n`)
  console.log('  Open the app — run:\n')
  console.log(`      open dist/${macDir}/Switchboard.app\n`)
  console.log('  Then use it like a normal Mac app:')
  console.log('    • Add it to your Dock — drag or pin it like any other app.')
  console.log('    • Optional — drag it into /Applications, or keep running it from dist/.')
  console.log('\n  Re-run `npm run setup` any time to rebuild and update the app.')
  console.log('  Note: Switchboard drives the `claude` CLI — make sure Claude Code is installed.')
} else {
  console.log('  Built the app, but could not find dist/mac*/Switchboard.app —')
  console.log('  check the electron-builder output above.')
}
