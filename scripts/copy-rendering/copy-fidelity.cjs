module.exports = async function checkCopyFidelity({ js, call, check, theme, agent }) {
  const prefix = theme + '/' + agent + '/fidelity/'
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const snapshot = (normalizeWhitespace = false) => js(`(() => {
    const md = document.querySelector('.md'), walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT), chars = [];
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (parent.closest('button,[data-md-skip]')) continue;
      const styles = (parent.closest('em') ? 1 : 0) | (parent.closest('strong') ? 2 : 0) | (parent.closest('del') ? 4 : 0);
      for (const text of node.data) chars.push({ text, styles: ${normalizeWhitespace} && /\\s/.test(text) ? 0 : styles, code: !!parent.closest('code'), link: parent.closest('a')?.getAttribute('href') ?? null });
    }
    return { chars, blocks: [...md.querySelectorAll('h1,h2,blockquote,ul,ol,li')].map(el => el.tagName) };
  })()`)
  async function roundtrip(name, source, normalizeWhitespace = false, requireStyle = false) {
    await call('mountCopy', { source, theme, agent })
    const before = await snapshot(normalizeWhitespace)
    if (requireStyle) check(prefix + name + '/styled-source', before.chars.some(char => char.styles !== 0), true)
    const copied = (await call('copyContents', '.md')).text
    await call('mountCopy', { source: copied, theme, agent })
    check(prefix + name, JSON.stringify(await snapshot(normalizeWhitespace)), JSON.stringify(before))
  }
  for (const source of [
    'L **_a_***_b_* R', 'L **_a_**_~~b~~_ R', 'L *~~a~~* **_b_** R',
    'L **_aa_***_bb_* R', 'L **alpha *beta* gamma** R',
    'L **`code`** *[link](https://example.org)* R', '**\\~\\~bar\\~\\~** tail'
  ]) await roundtrip('nested/' + source, source)
  for (const source of ['L ~~a *b*~~ R', 'L ~~*a* b~~ R', 'L ~~a **b** c~~ R', 'L ~~a\u00a0_b_~~ R']) {
    await roundtrip('strike-boundary/' + source, source, true)
  }
  for (const source of [
    'x*_a*y', 'x**~a**', 'L *a*\\*b R', 'L ~~a~~\\~b R', 'L \\*b*a* R', 'L *a*__.__ R',
    'x*a*__.__ R', 'L __.__*a*y', 'α*_a*y', '𝔸*_a*y', '🐈*_a*y', 'x*a_**b*𝔸',
    'L [x*_a*y](https://example.org) R', 'L **[x*_a*y](https://example.org)** R',
    'L **`_a*`** R', 'L *`a\\b`* R',
    '&#120;**`_a*`**&#121;', '&#120;*[a](https://example.org)*&#121;'
  ]) await roundtrip('delimiter-context/' + source, source, false, true)
  const atoms = () => js(`Array.from(document.querySelectorAll('.md-p .md-code,.md-p .md-math,.md-p .md-math-src'), el => ({
    kind: el.matches('.md-code') ? 'code' : 'math', value: (el.querySelector('.md-math-tex') ?? el).textContent,
    styles: (el.closest('em') ? 1 : 0) | (el.closest('strong') ? 2 : 0) | (el.closest('del') ? 4 : 0)
  }))`)
  for (const kind of ['code', 'math']) for (const styles of [1, 2, 3, 5, 6, 7]) for (const count of [2, 3, 4]) {
    const values = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index))
    const body = values.map((value, index) => {
      let part = kind === 'code' ? '`' + value + '`' : '$' + value + '$'
      if (styles & 4) part = '~~' + part + '~~'
      const marker = index % 2 ? '_' : '*'
      if (styles & 2) part = marker.repeat(2) + part + marker.repeat(2)
      if (styles & 1) part = marker + part + marker
      return part
    }).join('')
    const gate = kind === 'math' ? '\n\n$$\nx\n$$' : ''
    const source = 'L ' + body + ' R' + gate
    const expected = JSON.stringify(values.map(value => ({ kind, value, styles })))
    for (const reverse of [false, true]) {
      const label = prefix + 'adjacent-atoms/' + kind + '/' + styles + '/' + count + '/' + reverse
      await call('mountCopy', { source, theme, agent })
      await settle()
      check(label + '/fixture', JSON.stringify(await atoms()), expected)
      const copied = (await call('copyNodes', ['.md-p'], ['.md-p'], reverse)).text
      check(label + '/exact', (await call('copyContents', kind === 'code' ? '.md-code' : '.md-math,.md-math-src')).text, 'a')
      await call('mountCopy', { source: copied + gate, theme, agent })
      await settle()
      check(label + '/roundtrip', JSON.stringify(await atoms()), expected)
      await call('copyMode', 'plain')
      check(label + '/text', (await call('copyContents', '.md-p')).text, 'L ' + values.join('') + ' R')
    }
  }
  for (const source of ['L *`a` $b$ `c`* R\n\n$$\nx\n$$', 'L *`` a` ``*_`` `b ``_ R']) {
    await call('mountCopy', { source, theme, agent })
    await settle()
    const before = JSON.stringify(await atoms())
    const copied = (await call('copyContents', '.md')).text
    await call('mountCopy', { source: copied, theme, agent })
    await settle()
    check(prefix + 'atom-payloads/' + source, JSON.stringify(await atoms()), before)
  }
  for (const count of [1, 2, 3]) for (const [body, selector] of [
    ['**AlphaBREAKSBravo**', '.md-strong'], ['*AlphaBREAKSBravo*', '.md-em'],
    ['[AlphaBREAKSBravo](https://example.org)', '.md a'], ['- AlphaBREAKSBravo', '.md-li'],
    ['> AlphaBREAKSBravo', '.md blockquote .md-p']
  ]) for (const mode of ['markdown', 'plain']) for (const reverse of [false, true]) {
    const breaks = '\\\n'.repeat(count).replace(/\n/g, body.startsWith('- ') ? '\n  ' : body.startsWith('> ') ? '\n> ' : '\n')
    const source = body.replace('BREAKS', breaks)
    const label = prefix + 'trailing-breaks/' + count + '/' + selector + '/' + mode + '/' + reverse
    await call('mountCopy', { source, theme, agent, mode })
    check(label + '/fixture', await js("document.querySelectorAll('.md br').length"), count)
    const copied = (await call('copyRange', [selector, 0], [selector, 5 + count], reverse)).text
    check(label + '/bytes', copied, 'Alpha' + '\n'.repeat(count))
    await call('mountCopy', { source: copied, theme, agent })
    check(label + '/rendered', await js("document.querySelector('.md').textContent"), 'Alpha')
    check(label + '/no-generated-breaks', await js("document.querySelectorAll('.md br').length"), 0)
  }
  await roundtrip('enclosed-final-break', 'L [Alpha\\\n\\\n](https://example.org) R')
  for (const count of [1, 2, 3]) {
    const breaks = '\\\n'.repeat(count)
    for (const source of ['L **Alpha' + breaks + 'Bravo** R', 'L *Alpha' + breaks + 'Bravo* R',
      'L [Alpha' + breaks + 'Bravo](https://example.org) R', '- Alpha' + breaks.replace(/\n/g, '\n  ') + 'Bravo\n- second']) {
      await call('mountCopy', { source, theme, agent })
      check(prefix + 'consecutive-fixture/' + count + '/' + source, await js("document.querySelectorAll('.md br').length"), count)
      await roundtrip('consecutive-breaks/' + count + '/' + source, source)
      check(prefix + 'consecutive-count/' + count + '/' + source, await js("document.querySelectorAll('.md br').length"), count)
    }
  }
  await call('mountCopy', { source: 'L **Alpha\\\n\\\nBravo** R', theme, agent })
  for (const mode of ['markdown', 'plain']) {
    await call('copyMode', mode)
    for (const reverse of [false, true]) {
      check(prefix + 'consecutive-partial/' + mode + '/' + reverse,
        (await call('copyRange', ['.md-strong', 3], ['.md-strong', 9], reverse)).text,
        mode === 'markdown' ? 'ha\\\n\\\nBr' : 'ha\n\nBr')
      check(prefix + 'consecutive-only/' + mode + '/' + reverse,
        (await call('copyRange', ['.md-strong', 5], ['.md-strong', 7], reverse)).text, '\n\n')
    }
  }
  await call('mountCopy', { source: '| \\*prefix | *a* | tail\\* |\n| --- | --- | --- |', theme, agent })
  const tsv = (await call('copyContents', 'table')).text
  check(prefix + 'tsv-mixed-protection', tsv, '\\*prefix\t*a*\ttail\\*')
  await call('mountCopy', { source: tsv, theme, agent })
  check(prefix + 'tsv-mixed-styles', await js("Array.from(document.querySelectorAll('.md em'), el => el.textContent).join('')"), 'a')
  await call('mountCopy', { source: 'L **_aa_***_bb_* R', theme, agent })
  check(prefix + 'nested-exact', (await call('copyContents', '.md-strong')).text, 'aa')
  for (const reverse of [false, true]) {
    check(prefix + 'nested-partial/' + reverse,
      (await call('copyRange', ['.md-p', 3], ['.md-p', 6], reverse)).text, 'a*bb*')
  }
  await call('copyMode', 'plain')
  check(prefix + 'nested-plain', (await call('copyContents', '.md')).text, 'L aabb R')
  for (const [source, literal] of [
    ['\\~\\~bar\\~\\~', '~~bar~~'], ['\\&copy;', '&copy;'], ['\\# heading', '# heading'],
    ['\\> quote', '> quote'], ['\\- nested', '- nested'], ['\\+ nested', '+ nested'],
    ['1\\. nested', '1. nested'], ['1\\) nested', '1) nested'], ['\\<b>text\\</b>', '<b>text</b>']
  ]) {
    const list = '- ' + source + '\n- second'
    await roundtrip('punctuation/' + literal, list)
    await call('mountCopy', { source: list, theme, agent })
    check(prefix + 'punctuation-exact/' + literal, (await call('copyContents', '.md-li')).text, literal)
    await call('copyMode', 'plain')
    check(prefix + 'punctuation-plain/' + literal, (await call('copyContents', '.md')).text, '- ' + literal + '\n- second')
  }
  for (const [source, expected] of [
    ['<div>alpha</div>\n\n<div>beta</div>', '<div>alpha</div>\n<div>beta</div>'],
    ['Before\n\n<div>alpha</div>\n\n<div>beta</div>\n\nAfter', 'Before\n\n<div>alpha</div>\n<div>beta</div>\n\nAfter']
  ]) for (const mode of ['markdown', 'plain']) {
    await call('mountCopy', { source, theme, agent, mode })
    for (const reverse of [false, true]) {
      check(prefix + 'flow/' + mode + '/' + reverse + '/' + source,
        (await call('copyNodes', ['.md'], ['.md'], reverse)).text, expected)
    }
  }
  for (const [source, selector, markdown] of [
    ['L **Alpha  \nBravo** R', '.md-strong', 'L **Alpha\\\nBravo** R'],
    ['L *Alpha  \nBravo* R', '.md-em', 'L *Alpha\\\nBravo* R'],
    ['L [Alpha  \nBravo](https://example.org) R', '.md a', 'L [Alpha\\\nBravo](<https://example.org>) R']
  ]) {
    await roundtrip('hard-break-roundtrip/' + selector, source)
    for (const mode of ['markdown', 'plain']) for (const joined of [false, true]) {
      await call('mountCopy', { source, theme, agent, mode })
      if (joined) await js(`(() => {
        // Joining a clone's adjacent text nodes leaves React's own nodes intact for later renders.
        const original = document.querySelector('.md'), clone = original.cloneNode(true);
        clone.normalize(); original.replaceWith(clone);
        window.restoreCopyDom = () => clone.replaceWith(original);
      })()`)
      try {
        const label = prefix + 'hard-break/' + selector + '/' + mode + '/' + joined
        const newline = mode === 'markdown' ? '\\\n' : '\n'
        for (const reverse of [false, true]) {
          check(label + '/full/' + reverse, (await call('copyNodes', ['.md-p'], ['.md-p'], reverse)).text,
            mode === 'markdown' ? markdown : 'L Alpha\nBravo R')
          check(label + '/exact/' + reverse, (await call('copyNodes', [selector], [selector], reverse)).text,
            'Alpha' + newline + 'Bravo')
          for (const [name, from, to, expected] of [
            ['crossing', 3, 8, 'ha' + newline + 'Br'], ['before', 0, 5, 'Alpha'], ['after', 6, 11, 'Bravo'],
            ['through-left', 0, 6, 'Alpha\n'], ['through-right', 5, 11, newline + 'Bravo'], ['only-break', 5, 6, '\n']
          ]) check(label + '/' + name + '/' + reverse,
            (await call('copyRange', [selector, from], [selector, to], reverse)).text, expected)
          check(label + '/renderer-newline-only/' + reverse,
            (await call('copyBreakTail', selector, 0, 1, reverse)).text, '\n')
          if (joined) {
            check(label + '/joined-prefix/' + reverse,
              (await call('copyBreakTail', selector, 0, 3, reverse)).text, newline + 'Br')
            check(label + '/joined-after/' + reverse,
              (await call('copyBreakTail', selector, 1, 3, reverse)).text, 'Br')
          }
        }
      } finally {
        if (joined) await js('window.restoreCopyDom(); delete window.restoreCopyDom')
      }
    }
  }
  const metadata = () => js(`Array.from(document.querySelectorAll('.md a,.md-image'), el => ({
    kind: el.matches('a') ? 'link' : 'image',
    url: el.getAttribute(el.matches('a') ? 'href' : 'data-copy-url'), title: el.getAttribute('data-copy-title')
  }))`)
  for (const kind of ['link', 'image']) for (const [destination, title, normalized] of [
    ['', 'title'],
    ['', ''],
    ['a&#10;b', 'line ending', 'a%0Ab'], ['a&#13;b', 'line ending', 'a%0Db'],
    ['a&#13;&#10;b', 'line ending', 'a%0D%0Ab'], ['a&#10;b\\&copy;\\&#10;', 'literal references', 'a%0Ab&copy;&#10;'],
    ['https://example.org', 'line\nbreak \\&copy; \\&#10;'],
    ['https://example.org', 'line\rbreak'],
    ['https://example.org', 'line\r\nbreak'],
    [String.raw`https://example.org/\&copy;`, String.raw`a\&copy;`],
    [String.raw`https://example.org/a\<b\>c`, 'angle < title >'],
    [String.raw`https://example.org/a\\b`, String.raw`say \"hi\" \\ ok`],
    [String.raw`https://example.org/?a=1\&b=2\&#65;`, String.raw`number \&#65;`]
  ]) {
    const source = 'L ' + (kind === 'image' ? '!' : '') + '[label](<' + destination + '> "' + title + '") R'
    for (const reverse of [false, true]) {
      await call('mountCopy', { source, theme, agent })
      const before = await metadata()
      check(prefix + 'metadata-fixture/' + kind + '/' + destination + '/' + reverse, before.length, 1)
      if (normalized !== undefined) check(prefix + 'metadata-normalized/' + kind + '/' + destination + '/' + reverse,
        before[0].url, normalized)
      const copied = (await call('copyNodes', ['.md'], ['.md'], reverse)).text
      check(prefix + 'metadata-exact/' + kind + '/' + reverse,
        (await call('copyContents', kind === 'image' ? '.md-image' : '.md a')).text, 'label')
      await call('copyMode', 'plain')
      check(prefix + 'metadata-plain/' + kind + '/' + reverse, (await call('copyContents', '.md')).text, 'L label R')
      await call('mountCopy', { source: copied, theme, agent })
      check(prefix + 'metadata-roundtrip/' + kind + '/' + destination + '/' + reverse,
        JSON.stringify(await metadata()), JSON.stringify(before))
    }
  }
  const cells = () => js(`Array.from(document.querySelectorAll('table th, table td'), cell =>
    (cell.querySelector('.md-math-tex,.md-math-src') ?? cell).textContent)`)
  for (const pairs of [0, 1, 2]) {
    const protectedPipe = 'a' + '\\'.repeat(pairs * 2 + 1) + '|b'
    const values = ['a' + '\\'.repeat(pairs) + '|b', 'a' + '\\'.repeat(pairs) + '|b',
      'a' + '\\'.repeat(pairs * 2) + '|b', protectedPipe]
    const source = 'L\n\n| Text | Bold | Code | Math |\n| --- | --- | --- | --- |\n| ' + protectedPipe + ' | **' + protectedPipe + '** | `' + protectedPipe + '` | $' + protectedPipe + '$ |\n\n$$\nx^2\n$$\n\nR'
    await call('mountCopy', { source, theme, agent })
    await settle()
    const expected = ['Text', 'Bold', 'Code', 'Math', ...values]
    check(prefix + 'table-fixture/' + pairs, JSON.stringify(await cells()), JSON.stringify(expected))
    const copied = (await call('copyContents', '.md')).text
    await call('copyMode', 'plain')
    check(prefix + 'table-plain/' + pairs, (await call('copyContents', 'table')).text,
      'Text\tBold\tCode\tMath\n' + values.join('\t'))
    await call('mountCopy', { source: copied, theme, agent })
    await settle()
    check(prefix + 'table-roundtrip/' + pairs, JSON.stringify(await cells()), JSON.stringify(expected))
  }
}
