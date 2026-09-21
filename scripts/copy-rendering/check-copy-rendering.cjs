const { join } = require('node:path')
const runRenderingCheck = require('../rendering-harness.cjs')

runRenderingCheck({
  label: 'Copy', name: 'CopyFixture',
  entry: join(__dirname, 'copy-fixture.jsx'), runner: join(__dirname, 'copy-electron.cjs')
})
