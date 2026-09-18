const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const output = process.argv[2]
app.setPath('userData', join(output, 'profile'))
const results = [], failures = []
let win
const js = code => win.webContents.executeJavaScript(code)
const call = (name, ...args) => js(`window.${name}(${args.map(arg => JSON.stringify(arg)).join(',')})`)
function check(name, actual, expected) {
  results.push({ name, actual, expected })
  if (actual !== expected) failures.push({ name, actual, expected })
}
const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
async function expectRange(name, start, end, expected, reverse = false) {
  const result = await call('copyRange', start, end, reverse)
  check(name, result.text, expected)
  check(name + ' / handled', result.prevented, true)
}
async function expectContents(name, selector, expected, index = 0) {
  const result = await call('copyContents', selector, index)
  check(name, result.text, expected)
}
const message = (uuid, blocks, role = 'assistant', userKind) => ({ uuid, blocks, role, userKind, timestamp: null, isSidechain: false })
const text = value => ({ kind: 'text', text: value })

async function run() {
  for (const theme of ['light', 'dark']) for (const agent of ['claude', 'codex']) {
    const prefix = theme + '/' + agent + '/'
    for (const [name, source, marked] of [
      ['bold', 'L **abc** R', 'L **abc** R'], ['italic', 'L *abc* R', 'L *abc* R'],
      ['strike', 'L ~~abc~~ R', 'L ~~abc~~ R'], ['code', 'L `abc` R', 'L `abc` R'],
      ['link', 'L [abc](https://example.org/abc) R', 'L [abc](<https://example.org/abc>) R']
    ]) {
      await call('mountCopy', { source, theme, agent })
      for (const mode of ['markdown', 'plain']) {
        await call('copyMode', mode)
        for (const [label, from, to, expected] of [
          ['exact', 2, 5, 'abc'], ['left', 0, 5, 'L abc'], ['right', 2, 7, 'abc R'],
          ['spaces', 1, 6, ' abc '], ['left-space-only', 1, 7, ' abc R'], ['right-space-only', 0, 6, 'L abc '], ['both', 0, 7, mode === 'markdown' ? marked : 'L abc R'],
          ['partial-left', 0, 4, 'L ab'], ['partial-right', 3, 7, 'bc R'], ['inside', 3, 4, 'b']
        ]) for (const reverse of [false, true]) {
          await expectRange(prefix + name + '/' + mode + '/' + label + '/' + reverse,
            ['.md-p', from], ['.md-p', to], expected, reverse)
        }
      }
    }
    for (const source of ['`abc`', '**`abc`**', '## `abc`', '- `abc`']) {
      await call('mountCopy', { source, theme, agent })
      await expectContents(prefix + 'code-only/' + source, '.md-code', 'abc')
    }
    await call('mountCopy', { source: '**alpha *beta* gamma**', theme, agent })
    await expectContents(prefix + 'nested', '.md', 'alpha *beta* gamma')
    for (const blocks of [[text('Before\n\n```sh\n  abc\nxyz\n```\n\nAfter')],
      [text('Before'), text('```sh\n  abc\nxyz\n```'), text('After')]]) {
      await call('mountCopy', { blocks, theme, agent })
      await expectRange(prefix + 'fence/exact', ['.md-pre', 0], ['.md-pre', 9], '  abc\nxyz')
      await expectRange(prefix + 'fence/partial-right', ['.md-pre', 3], ['.md-p', 5, 1], 'bc\nxyz\n\nAfter')
      await expectRange(prefix + 'fence/partial-left', ['.md-p', 0], ['.md-pre', 4], 'Before\n\n  ab')
      await expectRange(prefix + 'fence/both', ['.md-p', 0], ['.md-p', 5, 1], 'Before\n\n```sh\n  abc\nxyz\n```\n\nAfter')
    }
    await call('mountCopy', { source: 'L `😀 café` R', theme, agent })
    await expectContents(prefix + 'unicode/exact', '.md-code', '😀 café')
    await expectRange(prefix + 'unicode/partial', ['.md-code', 3], ['.md-code', 7], 'café')
    await expectContents(prefix + 'unicode/both', '.md-p', 'L `😀 café` R')
    await call('mountCopy', { source: '\u00a0**abc**\u00a0', theme, agent })
    await expectContents(prefix + 'unicode/whitespace', '.md-p', '\u00a0abc\u00a0')
    await call('mountCopy', { source: 'Alpha &amp; Bravo', theme, agent })
    await expectRange(prefix + 'entity', ['.md-p', 6], ['.md-p', 7], '&')
    await call('mountCopy', { source: 'Alpha \\*Bravo\\* Charlie', theme, agent })
    await expectRange(prefix + 'escape', ['.md-p', 6], ['.md-p', 13], '*Bravo*')
    await call('mountCopy', { source: 'L `Alpha\nBravo` R', theme, agent })
    await expectContents(prefix + 'normalized-inline-code', '.md-code', 'Alpha Bravo')
    await call('mountCopy', { source: '    Alpha\n    Bravo', theme, agent })
    await expectRange(prefix + 'indented-code', ['.md-pre', 1], ['.md-pre', 4], 'lph')
    await call('mountCopy', { source: 'Alpha  \nBravo', theme, agent })
    await expectContents(prefix + 'hard-break', '.md-p', 'Alpha  \nBravo')
    await call('copyMode', 'plain')
    await expectContents(prefix + 'hard-break/plain', '.md-p', 'Alpha\nBravo')
    await call('mountCopy', { source: '- [x] Alpha\n- [ ] Bravo', theme, agent })
    await expectContents(prefix + 'task-list', '.md', '- [x] Alpha\n- [ ] Bravo')
    await expectRange(prefix + 'task-isolated', ['.md-li', 1], ['.md-li', 6], 'Alpha')
    await expectRange(prefix + 'task-partial', ['.md-li', 2], ['.md-li', 6, 1], 'lpha\n- [ ] Bravo')
    await call('mountCopy', { source: '| **A** | **B** | **C** |\n| --- | --- | --- |', theme, agent })
    await expectContents(prefix + 'table/nested', 'table', 'A\t**B**\tC')
    await expectContents(prefix + 'table/cell', 'th', 'B', 1)
    await call('copyMode', 'plain')
    await expectContents(prefix + 'table/plain', 'table', 'A\tB\tC')
    await call('mountCopy', { source: '| Left | Right |\n| --- | --- |\n| a\tb | say "hi" |', theme, agent })
    await expectContents(prefix + 'table/quoted', 'table', 'Left\tRight\n"a\tb"\t"say ""hi"""')
    await expectContents(prefix + 'table/single-literal', 'td', 'a\tb')
    await call('mountCopy', { source: '| Alpha | Bravo |\n| --- | --- |\n| Charlie | Delta |', theme, agent })
    await expectContents(prefix + 'table/first-body-cell', 'td', 'Charlie')
    await expectRange(prefix + 'table/ragged', ['th', 2, 1], ['td', 3], 'avo\nCha')
    await expectRange(prefix + 'table/cell-fragments', ['td', 1], ['td', 4, 1], 'harlie\tDelt')
    await call('mountCopy', { source: '| A | B | C |\n| --- | --- | --- |\n| x | | z |', theme, agent })
    await expectContents(prefix + 'table/empty-cell', 'tbody', 'x\t\tz')
    await call('mountCopy', { source: 'L ![image label](https://example.org/image.png) R', theme, agent })
    await expectRange(prefix + 'image-partial', ['[data-copy-label]', 6], ['[data-copy-label]', 11], 'label')
    await expectContents(prefix + 'image-surrounded', '.md', 'L ![image label](<https://example.org/image.png>) R')
    await call('mountCopy', { blocks: [text('L'), { kind: 'image', alt: 'uploaded image' }, text('R')], theme, agent })
    await expectContents(prefix + 'uploaded-image', '.transcript-content', 'L\n\nuploaded image\n\nR')
    await call('mountCopy', { source: 'Before[^a].\n\n[^a]: Note body\n\nAfter.', theme, agent })
    await expectRange(prefix + 'footnote-order', ['.md > p', 0, 1], ['[data-footnotes] p', 4], 'After.\n\nNote')
    await call('mountCopy', { source: 'L \\(\\frac{a}{b}\\) R\n\n\\[\nx^2\n\\]', theme, agent })
    await settle()
    await js('new Promise(resolve => setTimeout(resolve, 50))')
    await expectContents(prefix + 'math-atomic', '.md-math', '\\frac{a}{b}')
    await expectRange(prefix + 'math-glyph', ['.md-math [data-md-skip]', 0], ['.md-math [data-md-skip]', 1], '\\frac{a}{b}')
    await expectContents(prefix + 'math-block', '.md-math-display', 'x^2')
    await expectContents(prefix + 'math-surrounded', '.md-p', 'L $\\frac{a}{b}$ R')


    await call('mountCopy', { source: '## Title\n\n`abc`\n\n```sh\n  code\n\n```\n\n| A | B |\n| --- | --- |\n| a\tb | say "hi" |', theme, agent })
    for (const mode of ['markdown', 'plain']) {
      await call('copyMode', mode)
      check(prefix + 'code-button/' + mode, await call('copyButton', 'Copy code'), '  code\n')
      check(prefix + 'table-button/' + mode, await call('copyButton', 'Copy table'), mode === 'markdown'
        ? '| A | B |\n| --- | --- |\n| a\tb | say "hi" |' : 'A\tB\n"a\tb"\t"say ""hi"""')
      await js("document.querySelector('p code').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))")
      check(prefix + 'code-context/' + mode, await js('window.contextCopy'), 'abc')
      if (mode === 'plain') check(prefix + 'plain-turn-structure', await call('copyButton', 'Copy turn'), 'Title\n\nabc\n\n  code\n\n\nA\tB\n"a\tb"\t"say ""hi"""')
    }
    await call('mountCopy', { blocks: [{ kind: 'image', alt: 'only image' }], theme, agent })
    check(prefix + 'image-only-turn', await call('copyButton', 'Copy turn'), 'only image')
    await call('mountCopy', { source: 'L \\(\\notARealCommand{x}\\) R\n\n\\[\nx^2\n\\]', theme, agent })
    await settle()
    await expectRange(prefix + 'math-fallback-atomic', ['.md-math-src', 1], ['.md-math-src', 2], '\\notARealCommand{x}')
    await call('mountCopy', { source: '- outer\n  - inner one\n  - inner two\n- tail', theme, agent })
    await expectContents(prefix + 'nested-list', '.md-ul .md-ul', '- inner one\n- inner two')
    await call('mountCopy', { source: '- [x] outer\n  - child\n- end', theme, agent })
    await expectContents(prefix + 'nested-task-list', '.md', '- [x] outer\n  - child\n- end')
    await call('mountCopy', { source: 'L  R', theme, agent })
    await expectRange(prefix + 'whitespace-only', ['.md-p', 1], ['.md-p', 3], '  ')
    const emptyCopy = await call('copyContents', '.message-meta')
    check(prefix + 'chrome-empty', emptyCopy.text, '')
    check(prefix + 'chrome-handled', emptyCopy.prevented, true)
    await call('mountCopy', { source: 'Alpha  \nBravo', theme, agent })
    await expectRange(prefix + 'break-only', ['.md-p', 5], ['.md-p', 6], '\n')
    const messages = [message('before', [text('Before'), { kind: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo abc' } }]),
      message('result', [{ kind: 'tool_result', toolUseId: 't', text: 'abc', isError: false }], 'user', 'tool_result'),
      message('after', [text('After')])]
    await call('mountCopy', { messages, theme, agent })
    await expectContents(prefix + 'tools-closed', '.transcript-content', 'Before\n\nAfter')
    await call('openTools'); await settle()
    await expectContents(prefix + 'tool-exact', '.tool-result-text', 'abc')
    check(prefix + 'turn-excludes-tools', await call('copyButton', 'Copy turn'), 'Before\n\nAfter')
    check(prefix + 'conversation-excludes-tools', await call('copyButton', 'Copy entire conversation'), `**${agent === 'claude' ? 'Claude' : 'Codex'}:**\n\nBefore\n\nAfter`)
    check(prefix + 'raw-result', await call('copyButton', 'Copy result'), 'abc')
    await expectRange(prefix + 'tool-surrounded', ['.md-p', 0], ['.md-p', 5, 1], 'Before\n\nBash:\n\n```json\n{\n  "command": "echo abc"\n}\n```\n\nResult:\n\n```\nabc\n```\n\nAfter')

    await call('mountCopy', { messages: [message('u', [text('L')], 'user', 'human'), message('a', [text('**abc**')]), message('u2', [text('R')], 'user', 'human')], theme, agent })
    await expectContents(prefix + 'global-context', '.transcript-content', `**You:**\n\nL\n\n---\n\n**${agent === 'claude' ? 'Claude' : 'Codex'}:**\n\n**abc**\n\n---\n\n**You:**\n\nR`)
    await expectContents(prefix + 'labels-not-context', '.md', 'abc', 1)

    const full = Array.from({ length: 120 }, (_, i) => 'word' + String(i).padStart(3, '0')).join(' ') + ' HIDDEN_END'
    await call('mountCopy', { messages: [message('a', [{ kind: 'tool_use', id: 't', name: 'Read', input: {} }]),
      message('r', [{ kind: 'tool_result', toolUseId: 't', text: full, isError: false }], 'user', 'tool_result')], theme, agent, size: 540 })
    await call('openTools'); await settle(); await js('document.fonts.ready'); await settle()
    for (const zoom of [0, 1, 2]) {
      win.webContents.setZoomLevel(zoom)
      await settle()
      const expected = await call('clampExpected')
      const actual = (await call('copyContents', '.tool-result-text')).text
      check(prefix + 'clamp/' + zoom, actual, expected.prefix)
      check(prefix + 'clamp-hidden/' + zoom, actual.includes('HIDDEN_END'), false)
    }
    win.webContents.setZoomLevel(0)
    await settle()
    await call('expandResult'); await settle()
    await expectContents(prefix + 'expanded-result', '.tool-result-text', full)
    check(prefix + 'result-button-full', await call('copyButton', 'Copy result'), full)
  }
  const messages = Array.from({ length: 80 }, (_, i) => message('m' + i, [text('message ' + i)], i % 2 ? 'assistant' : 'user', i % 2 ? undefined : 'human'))
  await call('mountCopy', { messages })
  check('windowed-tail', (await call('copyStats')).articles, 60)
  const exported = await call('copyButton', 'Copy entire conversation')
  check('unmounted-export', exported.includes('message 0\n'), true)
  const large = 'a'.repeat(250000)
  await call('mountCopy', { source: large })
  const timing = await js("(() => { const start = performance.now(); const result = window.copyContents('.md'); return { ms: performance.now() - start, length: result.text.length } })()")
  check('large-selection-length', timing.length, 250000)
  results.push({ name: 'large-selection-ms', actual: timing.ms })
  check('renderer-errors', JSON.stringify((await call('copyStats')).errors), '[]')
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { contextIsolation: false } })
  try {
    await win.loadFile(join(output, 'dist/index.html'))
    await run()
  } catch (error) { failures.push({ name: 'fixture-error', error: String(error), stack: error.stack }) }
  writeFileSync(join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2))
  for (const failure of failures) console.error(JSON.stringify(failure))
  console.log(`Copy renderer: ${results.length} checks, ${failures.length} failures`)
  app.exit(failures.length ? 1 : 0)
})
