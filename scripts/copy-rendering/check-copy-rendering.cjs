const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { createRequire } = require('node:module')

const root = resolve(process.argv[2] || process.cwd())
const fromRoot = createRequire(join(root, 'package.json'))
const output = mkdtempSync(join(tmpdir(), 'switchboard-copy-rendering-'))
async function main() {
  await fromRoot('vite').build({
    configFile: false, root: output, logLevel: 'warn', esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    resolve: { alias: {
      '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer'),
      react: join(root, 'node_modules/react'), 'react-dom': join(root, 'node_modules/react-dom'),
      '@fontsource': join(root, 'node_modules/@fontsource')
    } },
    build: { outDir: join(output, 'dist'), lib: {
      entry: join(__dirname, 'copy-fixture.jsx'), formats: ['iife'], name: 'CopyFixture',
      fileName: () => 'fixture.js', cssFileName: 'fixture'
    } }
  })
  writeFileSync(join(output, 'dist/index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const result = spawnSync(fromRoot('electron'), [join(__dirname, 'copy-electron.cjs'), output], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  })
  if (result.error) throw result.error
  if (result.signal) throw new Error('Electron terminated: ' + result.signal)
  console.log('Copy rendering artifacts: ' + output)
  process.exitCode = result.status ?? 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
