module.exports = async function checkCopyFidelity({ js, call, check, theme, agent }) {
  const prefix = theme + '/' + agent + '/fidelity/'
  const settle = () => js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const snapshot = () => js(`(() => {
    const md = document.querySelector('.md'), walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT), chars = [];
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (parent.closest('button,[data-md-skip]')) continue;
      const styles = (parent.closest('em') ? 1 : 0) | (parent.closest('strong') ? 2 : 0) | (parent.closest('del') ? 4 : 0);
      for (const text of node.data) chars.push({ text, styles, code: !!parent.closest('code'), link: parent.closest('a')?.getAttribute('href') ?? null });
    }
    return { chars, blocks: [...md.querySelectorAll('h1,h2,blockquote,ul,ol,li')].map(el => el.tagName) };
  })()`)
  async function roundtrip(name, source) {
    await call('mountCopy', { source, theme, agent })
    const before = await snapshot()
    const copied = (await call('copyContents', '.md')).text
    await call('mountCopy', { source: copied, theme, agent })
    check(prefix + name, JSON.stringify(await snapshot()), JSON.stringify(before))
  }
  for (const source of [
    'L **_a_***_b_* R', 'L **_a_**_~~b~~_ R', 'L *~~a~~* **_b_** R',
    'L **_aa_***_bb_* R', 'L **alpha *beta* gamma** R',
    'L **`code`** *[link](https://example.org)* R', '**\\~\\~bar\\~\\~** tail'
  ]) await roundtrip('nested/' + source, source)
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
