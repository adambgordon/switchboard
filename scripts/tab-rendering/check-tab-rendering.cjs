const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { createRequire } = require('node:module')

const root = resolve(process.argv[2] || process.cwd())
const fromRoot = createRequire(join(root, 'package.json'))
const output = mkdtempSync(join(tmpdir(), 'switchboard-tab-rendering-'))
const built = join(output, 'dist')
async function main() {
  await fromRoot('vite').build({
    configFile: false, root: output, logLevel: 'warn', esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    resolve: { alias: {
      '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer'),
      react: join(root, 'node_modules/react'), 'react-dom': join(root, 'node_modules/react-dom'),
      '@fontsource': join(root, 'node_modules/@fontsource')
    } },
    build: {
      outDir: built, emptyOutDir: false,
      lib: { entry: join(__dirname, 'tab-rendering-fixture.jsx'), formats: ['iife'], name: 'TabRenderingFixture',
        fileName: () => 'fixture.js', cssFileName: 'fixture' }
    }
  })
  writeFileSync(join(built, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
  const result = spawnSync(fromRoot('electron'), [join(__dirname, 'tab-rendering-electron.cjs'), built], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  })
  console.log(`Tab rendering artifacts: ${output}`)
  process.exitCode = result.status ?? 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
