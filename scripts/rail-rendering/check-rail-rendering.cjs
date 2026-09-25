const { join } = require('node:path')
const runRenderingCheck = require('../rendering-harness.cjs')

runRenderingCheck({
  label: 'Rail', name: 'RailRenderingFixture',
  entry: join(__dirname, 'rail-rendering-fixture.jsx'), runner: join(__dirname, 'rail-rendering-electron.cjs')
})
