const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
const checkCopyFidelity = require('./copy-fidelity.cjs')
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
async function dragAcross(selector) {
  await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'center' })`)
  await settle()
  const rect = await js(`(() => {
    window.getSelection().removeAllRanges();
    return document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON();
  })()`)
  const mouse = (type, x) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type, x, y: rect.top + rect.height / 2, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1
  })
  await mouse('mouseMoved', rect.left + 0.5)
  await mouse('mousePressed', rect.left + 0.5)
  for (let step = 1; step <= 4; step++) await mouse('mouseMoved', rect.left + 0.5 + (rect.width - 1) * step / 4)
  await mouse('mouseReleased', rect.right - 0.5)
  return js('window.getSelection().toString()')
}
async function expectUnselectable(prefix, selectors) {
  for (const selector of selectors) {
    const styles = await js(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(el => getComputedStyle(el).userSelect)`)
    check(prefix + '/present/' + selector, styles.length > 0, true)
    check(prefix + '/unselectable/' + selector, styles.every(value => value === 'none'), true)
  }
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
          ['exact', 2, 5, 'abc'], ['left', 0, 5, mode === 'markdown' ? marked.slice(0, -2) : 'L abc'], ['right', 2, 7, mode === 'markdown' ? marked.slice(2) : 'abc R'],
          ['spaces', 1, 6, ' abc '], ['left-space-only', 1, 7, mode === 'markdown' ? marked.slice(1) : ' abc R'], ['right-space-only', 0, 6, mode === 'markdown' ? marked.slice(0, -1) : 'L abc '], ['both', 0, 7, mode === 'markdown' ? marked : 'L abc R'],
          ['partial-left', 0, 4, 'L ab'], ['partial-right', 3, 7, 'bc R'], ['inside', 3, 4, 'b']
        ]) for (const reverse of [false, true]) {
          await expectRange(prefix + name + '/' + mode + '/' + label + '/' + reverse,
            ['.md-p', from], ['.md-p', to], expected, reverse)
        }
      }
    }
    for (const [source, md, plain] of [
      ['- **a** **b**', '**a** **b**', 'a b'],
      ['- `a` `b`', '`a` `b`', 'a b'],
      ['- [a](https://example.org) **b**', '[a](<https://example.org>) **b**', 'a b'],
      ['- **a**\n  **b**', '**a**\n**b**', 'a\nb'],
      ['- [x] **a** **b**', '**a** **b**', 'a b'],
      ['- **a** **b**\n  - child\n- end', '- **a** **b**\n  - child\n- end', '- a b\n  - child\n- end'],
      ['- **a** **b**\n\n  next\n\n- end', '- **a** **b**\n  \n  next\n- end', '- a b\n  \n  next\n- end']
    ]) {
      await call('mountCopy', { source, theme, agent })
      await expectContents(prefix + 'inline-list-spacing/md/' + source, '.md', md)
      await call('copyMode', 'plain')
      await expectContents(prefix + 'inline-list-spacing/plain/' + source, '.md', plain)
    }
    const literal = 'a*b*c _d_ `e` [f](g) \\h'
    const escaped = 'a\\*b\\*c \\_d\\_ \\`e\\` \\[f\\]\\(g\\) \\\\h'
    for (const [kind, first, second] of [
      ['unordered', '- ', '- '], ['ordered', '3. ', '4. '], ['task', '- [x] ', '- [ ] ']
    ]) {
      const source = first + escaped + '\n' + second + 'second'
      for (const mode of ['markdown', 'plain']) {
        await call('mountCopy', { source, theme, agent, mode })
        const copied = (await call('copyContents', '.md')).text
        check(prefix + 'list-escape/' + kind + '/' + mode, copied,
          first + (mode === 'markdown' ? escaped : literal) + '\n' + second + 'second')
        // Text-node offsets in a task item include the renderer's space after its checkbox.
        const offset = kind === 'task' ? 1 : 0
        await expectRange(prefix + 'list-exact/' + kind + '/' + mode,
          ['.md-li', offset], ['.md-li', offset + literal.length], literal)
        await expectRange(prefix + 'list-fragment/' + kind + '/' + mode,
          ['.md-li', offset + 1], ['.md-li', offset + literal.length], literal.slice(1))
        await expectRange(prefix + 'list-partial-crossing/' + kind + '/' + mode,
          ['.md-li', offset + 1], ['.md-li', offset + 6, 1], literal.slice(1) + '\n' + second + 'second')
        if (mode === 'markdown') {
          await call('mountCopy', { source: copied, theme, agent })
          await expectRange(prefix + 'list-roundtrip/' + kind,
            ['.md-li', offset], ['.md-li', offset + literal.length], literal)
          check(prefix + 'list-roundtrip-styles/' + kind,
            await js("document.querySelectorAll('.md-li em, .md-li strong, .md-li code, .md-li a').length"), 0)
        }
      }
    }
    for (const mode of ['markdown', 'plain']) {
      const source = 'L\n\n> - outer\n>   - ' + escaped + '\n>   - second\n\nR'
      await call('mountCopy', { source, theme, agent, mode })
      const copied = (await call('copyContents', '.md')).text
      check(prefix + 'nested-quote-escape/' + mode, copied, mode === 'markdown' ? source
        : 'L\n\n- outer\n  - ' + literal + '\n  - second\n\nR')
      if (mode === 'markdown') {
        await call('mountCopy', { source: copied, theme, agent })
        await expectContents(prefix + 'nested-quote-roundtrip', '.md-ul .md-li .md-ul .md-li', literal)
        check(prefix + 'nested-quote-roundtrip-styles',
          await js("document.querySelectorAll('.md-li em, .md-li strong, .md-li code, .md-li a').length"), 0)
      }
    }
    for (const mode of ['markdown', 'plain']) {
      await call('mountCopy', { source: 'Before\n\n---\n\nAfter', theme, agent, mode })
      for (const [label, start, end, expected] of [
        ['both', ['.md-p'], ['.md-p', 1], 'Before\n\n---\n\nAfter'],
        ['left', ['.md-p'], ['.md-hr'], 'Before\n\n---'],
        ['right', ['.md-hr'], ['.md-p', 1], '---\n\nAfter'],
        ['isolated', ['.md-hr'], ['.md-hr'], '']
      ]) for (const reverse of [false, true]) {
        const result = await call('copyNodes', start, end, reverse)
        check(prefix + 'divider/' + mode + '/' + label + '/' + reverse, result.text, expected)
        check(prefix + 'divider-handled/' + mode + '/' + label + '/' + reverse, result.prevented, true)
        if (label === 'isolated') check(prefix + 'divider-empty-clipboard/' + mode + '/' + reverse, result.types.length, 0)
      }
      check(prefix + 'divider-turn/' + mode, await call('copyButton', 'Copy turn'), 'Before\n\n---\n\nAfter')
      await call('mountCopy', { source: '---', theme, agent, mode })
      check(prefix + 'divider-only-turn/' + mode, await call('copyButton', 'Copy turn'), '---')
    }
    await call('mountCopy', { source: '- **a** **b**', theme, agent })
    for (const mode of ['markdown', 'plain']) {
      await call('copyMode', mode)
      await expectRange(prefix + 'list-space-only/' + mode, ['.md-li', 1], ['.md-li', 2], ' ')
      await expectRange(prefix + 'list-partial/' + mode, ['.md-li', 1], ['.md-li', 3], ' b')
    }
    for (const [source, expected, strong, em, strike = ''] of [
      ['**a**__b__', 'ab', 'ab', ''], ['*a*_b_', 'ab', '', 'ab'],
      ['**_a_**__*b*__', 'ab', 'ab', 'ab'], ['**a***b*', 'ab', 'a', 'b'],
      ['**a** __b__', 'a b', 'ab', ''],
      ['L **a __b__ c** R', 'L a b c R', 'a b c', ''],
      ['*~~a~~*_~~b~~_', 'ab', '', 'ab', 'ab']
    ]) {
      await call('mountCopy', { source, theme, agent })
      const copied = (await call('copyContents', '.md')).text
      await call('mountCopy', { source: copied, theme, agent })
      const rendered = await js(`(() => {
        const md = document.querySelector('.md'), walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
        const out = { text: '', strong: '', em: '', strike: '' };
        while (walker.nextNode()) { const text = walker.currentNode; out.text += text.data;
          if (text.parentElement.closest('strong')) out.strong += text.data;
          if (text.parentElement.closest('em')) out.em += text.data;
          if (text.parentElement.closest('del')) out.strike += text.data;
        }
        return out;
      })()`)
      check(prefix + 'roundtrip-text/' + source, rendered.text, expected)
      check(prefix + 'roundtrip-bold/' + source, rendered.strong, strong)
      check(prefix + 'roundtrip-italic/' + source, rendered.em, em)
      check(prefix + 'roundtrip-strike/' + source, rendered.strike, strike)
    }
    await call('mountCopy', { source: '**aa**__bb__', theme, agent })
    await expectRange(prefix + 'adjacent-partial-both', ['.md-p', 1], ['.md-p', 3], 'ab')
    await expectRange(prefix + 'adjacent-partial-first', ['.md-p', 1], ['.md-p', 4], 'a**bb**')
    for (const reverse of [false, true]) {
      await call('mountCopy', { source: '| | B |\n| --- | --- |\n| C | D |\n\nAfter', theme, agent })
      const copied = await call('copyRange', ['th', 0, 1], ['.md-p', 5], reverse)
      check(prefix + 'empty-header-boundary/' + reverse, copied.text, 'B\nC\tD\n\nAfter')
      await call('mountCopy', { source: copied.text, theme, agent })
      check(prefix + 'empty-header-retains-D/' + reverse,
        await js("document.querySelector('.md').textContent.includes('D')"), true)
    }
    await call('mountCopy', { source: '| | B |\n| --- | --- |\n| C | D |\n\nAfter', theme, agent })
    await expectContents(prefix + 'empty-header-covered', '.md', '|  | B |\n| --- | --- |\n| C | D |\n\nAfter')
    check(prefix + 'empty-header-button', await call('copyButton', 'Copy table'), '| | B |\n| --- | --- |\n| C | D |')
    await call('mountCopy', { source: 'Before\n\n| A | B |\n| --- | --- |\n| C | |', theme, agent })
    await expectRange(prefix + 'empty-trailing-boundary', ['.md-p', 0], ['td', 1], 'Before\n\nA\tB\nC')
    await expectContents(prefix + 'empty-trailing-covered', '.md', 'Before\n\n| A | B |\n| --- | --- |\n| C |  |')
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
      await expectRange(prefix + 'fence/left-only', ['.md-p', 0], ['.md-pre', 9], 'Before\n\n```sh\n  abc\nxyz\n```')
      await expectRange(prefix + 'fence/right-only', ['.md-pre', 0], ['.md-p', 5, 1], '```sh\n  abc\nxyz\n```\n\nAfter')
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
    await expectContents(prefix + 'table/nested', 'table', '**A**\t**B**\t**C**')
    await expectContents(prefix + 'table/cell', 'th', 'B', 1)
    await call('copyMode', 'plain')
    await expectContents(prefix + 'table/plain', 'table', 'A\tB\tC')
    await call('mountCopy', { source: '| Topic | Finding |\n| --- | --- |\n| Config | `RuntimeOptions` only (refreshable) |\n| Note | Install-time `size-limit` silently ignored |', theme, agent })
    await expectContents(prefix + 'table/code-at-start', 'tbody tr:nth-child(1) td:nth-child(2)', '`RuntimeOptions` only (refreshable)')
    await expectContents(prefix + 'table/code-in-middle', 'tbody tr:nth-child(2) td:nth-child(2)', 'Install-time `size-limit` silently ignored')
    await expectContents(prefix + 'table/code-isolated', 'td code', 'RuntimeOptions')
    await call('mountCopy', { source: 'Before\n\n| A | B |\n| --- | --- |\n| C | D |\n\nAfter', theme, agent })
    await expectRange(prefix + 'table/left-only', ['.md-p', 0], ['td', 1, 1], 'Before\n\n| A | B |\n| --- | --- |\n| C | D |')
    await expectRange(prefix + 'table/right-only', ['th', 0], ['.md-p', 5, 1], '| A | B |\n| --- | --- |\n| C | D |\n\nAfter')
    await expectContents(prefix + 'table/exact-with-surroundings-unselected', 'table', 'A\tB\nC\tD')
    await call('mountCopy', { source: 'Before\n\n## Heading\n\nAfter', theme, agent })
    await expectContents(prefix + 'heading/exact', 'h2', 'Heading')
    await expectRange(prefix + 'heading/left-only', ['.md-p', 0], ['h2', 7], 'Before\n\n## Heading')
    await expectRange(prefix + 'heading/right-only', ['h2', 0], ['.md-p', 5, 1], '## Heading\n\nAfter')
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
    await expectUnselectable(prefix + 'chrome', ['.block-chip > [data-md-skip]'])
    await call('mountCopy', { source: 'Before[^a].\n\n[^a]: Note body\n\nAfter.', theme, agent })
    await expectRange(prefix + 'footnote-order', ['.md > p', 0, 1], ['[data-footnotes] p', 4], 'After.\n\nNote')
    await expectUnselectable(prefix + 'chrome', ['.message-meta .role-label', '.transcript-foot-label', '[data-footnote-backref]'])
    await js('document.fonts.ready')
    // Sweep the text and return link together: dragging only a link can trigger native link drag.
    check(prefix + 'footnote-body-selectable', (await dragAcross('[data-footnotes] p')).includes('Note body'), true)
    check(prefix + 'backlink-not-in-body-selection', await js("window.getSelection().toString().includes('↩')"), false)
    const backlink = await call('copyContents', '[data-footnote-backref]')
    check(prefix + 'backlink-empty', backlink.text, '')
    check(prefix + 'backlink-handled', backlink.prevented, true)
    check(prefix + 'backlink-clipboard-unchanged', backlink.types.length, 0)
    await call('mountCopy', { source: 'L \\(\\frac{a}{b}\\) R\n\n\\[\nx^2\n\\]', theme, agent })
    await settle()
    await js('new Promise(resolve => setTimeout(resolve, 50))')
    await expectContents(prefix + 'math-atomic', '.md-math', '\\frac{a}{b}')
    await expectRange(prefix + 'math-glyph', ['.md-math [data-md-skip]', 0], ['.md-math [data-md-skip]', 1], '\\frac{a}{b}')
    await expectContents(prefix + 'math-block', '.md-math-display', 'x^2')
    await expectContents(prefix + 'math-surrounded', '.md-p', 'L $\\frac{a}{b}$ R')
    await call('mountCopy', { source: 'L \\(x+y\\) R\n\n\\[\nx^2\n\\]', theme, agent })
    await settle()
    check(prefix + 'math-glyph-selectable', await js("getComputedStyle(document.querySelector('.md-math [data-md-skip]')).userSelect"), 'text')
    check(prefix + 'math-pointer-selection', (await dragAcross('.md-math .katex-html')).length > 0, true)
    check(prefix + 'math-pointer-copy', (await call('copyCurrent')).text, 'x+y')


    await call('mountCopy', { source: '## Title\n\n`abc`\n\n```sh\n  code\n\n```\n\n| A | B |\n| --- | --- |\n| a\tb | say "hi" |', theme, agent })
    await expectUnselectable(prefix + 'chrome', ['.md-lang'])
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
    await expectUnselectable(prefix + 'chrome', ['.tool-head'])
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
    await checkCopyFidelity({ js, call, check, theme, agent })
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
  const deadline = setTimeout(() => { console.error('Copy renderer check timed out'); app.exit(1) }, 120000)
  win = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: { contextIsolation: false, backgroundThrottling: false } })
  try {
    await win.loadFile(join(output, 'dist/index.html'))
    win.webContents.debugger.attach('1.3')
    await run()
  } catch (error) { failures.push({ name: 'fixture-error', error: String(error), stack: error.stack }) }
  clearTimeout(deadline)
  writeFileSync(join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2))
  for (const failure of failures) console.error(JSON.stringify(failure))
  console.log(`Copy renderer: ${results.length} checks, ${failures.length} failures`)
  app.exit(failures.length ? 1 : 0)
})
