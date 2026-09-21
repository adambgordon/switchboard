const { join } = require('node:path')
const runRenderingCheck = require('../rendering-harness.cjs')

runRenderingCheck({
  label: 'Tab', name: 'TabRenderingFixture',
  entry: join(__dirname, 'tab-rendering-fixture.jsx'), runner: join(__dirname, 'tab-rendering-electron.cjs')
})
