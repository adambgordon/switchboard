const { join } = require('node:path')
const runRenderingCheck = require('../rendering-harness.cjs')

async function main() {
  await runRenderingCheck({
    label: 'Tab', name: 'TabRenderingFixture',
    entry: join(__dirname, 'tab-rendering-fixture.jsx'), runner: join(__dirname, 'tab-rendering-electron.cjs')
  })
  // Each run sets the exit code; a failing tab check must not be masked by a passing hairline check.
  const tabs = process.exitCode
  await runRenderingCheck({
    label: 'Hairline', name: 'HairlineRenderingFixture',
    entry: join(__dirname, 'hairline-fixture.jsx'), runner: join(__dirname, 'hairline-electron.cjs')
  })
  if (tabs) process.exitCode = tabs
}

main()
