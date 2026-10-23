const { app, BrowserWindow, Menu, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { pixelsOf, profile } = require('./pixels.cjs')

const output = process.argv[2]
app.setPath('userData', join(output, 'profile'))
app.commandLine.appendSwitch('force-color-profile', 'srgb')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = [], failures = []
let win
const js = code => win.webContents.executeJavaScript(code)
const check = (condition, message) => { if (!condition) failures.push(message) }

async function settle() {
  await js('document.fonts.ready')
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await delay(60)
}

// Runs in the page. Every line is located from its own computed style, whichever technique draws it
// (a border, a filled box, or an inset shadow), so the check reads the same line before and after a
// change of technique. `axis` is the direction the profile crosses the line; `at` is where along the
// line it is taken; `from`/`to` bound the line's box across it, in CSS px.
function linesInPage() {
  const rgb = value => value.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
  const border = (style, side) => {
    const thickness = parseFloat(style['border' + side + 'Width'])
    return thickness > 0 ? { color: rgb(style['border' + side + 'Color']), thickness } : null
  }
  const rows = [...document.querySelectorAll('.hl-row')].map(row => {
    const element = selector => row.querySelector(selector)
    const box = selector => element(selector).getBoundingClientRect()
    const style = (selector, pseudo) => getComputedStyle(element(selector), pseudo)
    const rail = box('.hl-rail'), body = box('.hl-body'), pane = box('.sb-pane')
    const railX = (rail.left + rail.right) / 2
    const lines = []
    const add = (name, axis, at, from, paint) => lines.push({ name, axis, at, from, to: from + paint.thickness, color: paint.color })

    const title = border(style('.sb-titlebar'), 'Bottom')
    add('title-bar', 'y', railX, box('.sb-titlebar').bottom - title.thickness, title)
    const headAfter = style('.sb-rail-head', '::after')
    const head = (headAfter.content !== 'none' && border(headAfter, 'Bottom')) ||
      { color: rgb(style('.sb-rail-head').boxShadow), thickness: 1 }
    add('rail-head', 'y', railX, box('.sb-rail-head').bottom - head.thickness, head)
    const handle = box('.sb-resize-handle')
    add('divider', 'x', (body.top + body.bottom) / 2, handle.left, border(style('.sb-resize-handle'), 'Left') ||
      { color: rgb(style('.sb-resize-handle').backgroundColor), thickness: handle.width })
    const header = border(style('.sb-pane-header'), 'Bottom')
    add('pane-header', 'y', pane.left + 4, box('.sb-pane-header').bottom - header.thickness, header)
    for (const [name, selector] of [['menu-separator', '.sb-ctxmenu-sep'], ['transcript-foot', '.transcript-foot-rule']]) {
      const rect = box(selector)
      add(name, 'y', (rect.left + rect.right) / 2, rect.top, border(style(selector), 'Top') ||
        { color: rgb(style(selector).backgroundColor), thickness: rect.height })
    }
    const chooser = box('.sb-chooser-other'), chooserLine = style('.sb-chooser-other', '::before')
    add('chooser-separator', 'y', (chooser.left + chooser.right) / 2, chooser.top + parseFloat(chooserLine.top),
      border(chooserLine, 'Top') || { color: rgb(chooserLine.backgroundColor), thickness: parseFloat(chooserLine.height) })
    const tab = box('.sb-tab'), tabLine = style('.sb-tab', '::before')
    add('tab-drag-gap', 'x', (tab.top + tab.bottom) / 2, tab.left,
      border(tabLine, 'Left') || { color: rgb(tabLine.backgroundColor), thickness: parseFloat(tabLine.width) })
    // Which points across the divider grab it, measured from the line's center, in CSS px.
    const lineCenter = handle.left + handle.width / 2, grabY = (body.top + body.bottom) / 2
    const grab = [-4.5, -2.5, 0, 2.5, 4.5].map(dx =>
      ({ dx, hit: !!document.elementFromPoint(lineCenter + dx, grabY)?.closest('.sb-resize-handle') }))
    return { rail: Number(row.dataset.rail), lines, grab }
  })
  return { dpr: devicePixelRatio, width: innerWidth, rows, errors: window.auditErrors }
}

const sameColor = (a, b) => a.every((value, i) => Math.abs(value - b[i]) <= 2)

function measure(bitmap, scale, line) {
  const center = (line.from + line.to) / 2
  const from = Math.floor((center - 3) * scale), to = Math.ceil((center + 3) * scale)
  const fixed = Math.floor(line.at * scale)
  const samples = Array.from({ length: to - from + 1 }, (_, i) =>
    [from + i, line.axis === 'y' ? bitmap.at(fixed, from + i) : bitmap.at(from + i, fixed)])
  const result = profile(samples, center * scale, line.color)
  const before = samples[0][1], after = samples[samples.length - 1][1]
  return { ...result, before, after, contrast: Math.min(Math.abs(line.color[0] - before[0]), Math.abs(line.color[0] - after[0])) }
}

// Every hairline must paint what the title bar's border paints at the same zoom: the same count of
// mostly-covered device pixels and the same blended weight. A native border's width is floored to
// whole device pixels; a filled box rounds each of its edges separately, so its thickness depends on
// where it lands; an inset shadow is antialiased. Only the first agrees with the others everywhere.
async function capture(label) {
  const geometry = await js(`(${linesInPage})()`)
  const response = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
  const image = nativeImage.createFromBuffer(Buffer.from(response.data, 'base64'))
  const bitmap = pixelsOf(image), scale = geometry.dpr
  check(Math.abs(bitmap.width - geometry.width * scale) <= Math.ceil(scale), label + ': screenshot/DPR mismatch')
  check(geometry.errors.length === 0, label + ': renderer errors: ' + geometry.errors.join('; '))
  const rows = geometry.rows.map(({ rail, lines, grab }) => {
    // The grab area is centered on the line, about 3px either side, and nothing stacked over it
    // takes the pointer on either side.
    for (const { dx, hit } of grab) {
      check(hit === Math.abs(dx) < 3, `${label} rail ${rail}: ${hit ? 'grabs' : 'misses'} the divider ${dx}px from its center`)
    }
    const measured = lines.map(line => ({ ...line, ...measure(bitmap, scale, line) }))
    const title = measured.find(line => line.name === 'title-bar')
    check(title.painted.length > 0, `${label} rail ${rail}: absent title-bar reference`)
    for (const line of measured) {
      if (line === title) continue
      const where = `${label} rail ${rail}: ${line.name}`
      check(line.painted.length > 0, where + ' is absent')
      check(line.painted.length === title.painted.length,
        `${where} paints ${line.painted.length} device px, title bar ${title.painted.length}`)
      // Include partially blended pixels; exact-color counts alone can miss a heavier aliased edge.
      const tolerance = 2 / Math.min(line.contrast, title.contrast)
      check(Math.abs(line.weight - title.weight) <= tolerance,
        `${where} weighs ${line.weight.toFixed(2)}, title bar ${title.weight.toFixed(2)}`)
    }
    // A divider box wider than its line leaves a sliver of whatever lies behind it between the line
    // and a pane. Every pixel across it must be one of the two surfaces or the rule.
    const divider = measured.find(line => line.name === 'divider')
    const stray = divider.samples.filter(sample => ![divider.before, divider.after, divider.color].some(color => sameColor(sample.color, color)))
    check(stray.length === 0, `${label} rail ${rail}: divider leaves a sliver at device px ${stray.map(sample => sample.position).join(', ')}`)
    return { rail, grab, lines: measured.map(({ samples, ...line }) => ({ ...line, samples: samples.map(sample => [sample.position, sample.coverage]) })) }
  })
  results.push({ label, zoom: win.webContents.getZoomFactor(), dpr: scale, rows })
  writeFileSync(join(output, label + '.png'), image.toPNG())
  const counts = {}
  for (const row of rows) for (const line of row.lines) (counts[line.name] ||= new Set()).add(line.painted.length)
  console.log(JSON.stringify({ label, zoom: +win.webContents.getZoomFactor().toFixed(4), dpr: +scale.toFixed(4),
    painted: Object.fromEntries(Object.entries(counts).map(([name, set]) => [name, [...set].sort().join('/')])) }))
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => { console.error('Hairline renderer check timed out'); app.exit(1) }, 120000)
  try {
    win = new BrowserWindow({ width: 850, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
    win.setContentSize(850, 850)
    const menu = Menu.buildFromTemplate([{ label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }])
    Menu.setApplicationMenu(menu)
    await win.loadFile(join(output, 'dist/index.html'))
    win.webContents.debugger.attach('1.3')
    const [resetZoom, zoomIn, zoomOut] = menu.items[0].submenu.items
    const press = async item => { item.click({}, win, win.webContents); await settle() }
    for (const theme of ['light', 'dark']) {
      await js(`window.configure(${JSON.stringify({ theme })})`)
      // Let the lines' color transitions finish before anything is scored.
      await delay(400)
      for (const [item, direction, last] of [[zoomIn, 1, 8], [zoomOut, -1, 4]]) {
        await press(resetZoom)
        for (let count = 0; count <= last; count++) {
          if (count === 0 && direction < 0) continue
          if (count) await press(item)
          const step = direction * count
          assert(Math.abs(win.webContents.getZoomFactor() - 1.2 ** (step / 2)) < 1e-8, 'native menu zoom factor')
          await capture(`${theme}-zoom-${step}`)
        }
      }
    }
    writeFileSync(join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2))
    if (failures.length) console.error('Hairline renderer failures:\n' + [...new Set(failures)].join('\n'))
    else console.log('PASS every hairline paints like the title-bar border, and the divider grabs around its center, across both themes, native zoom steps, and rail widths')
  } catch (error) {
    failures.push(error.message)
    console.error(error.stack)
    writeFileSync(join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2))
  } finally {
    clearTimeout(deadline)
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(failures.length ? 1 : 0)
  }
})
