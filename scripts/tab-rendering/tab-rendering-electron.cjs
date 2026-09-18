const { app, BrowserWindow, Menu, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const checkDragScrolling = require('./drag-regression.cjs')

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
async function configure(config) {
  await js(`window.configure(${JSON.stringify(config)})`)
  await settle()
}
function pixelsOf(image) {
  const size = image.getSize(), bytes = image.toBitmap()
  assert.equal(bytes.length, size.width * size.height * 4, 'screenshot bitmap scale')
  return { ...size, at(x, y) {
    assert(x >= 0 && y >= 0 && x < size.width && y < size.height, `Pixel outside screenshot: ${x},${y}`)
    const i = (y * size.width + x) * 4
    return [bytes[i + 2], bytes[i + 1], bytes[i]]
  } }
}
function profile(samples, background, rule) {
  const coverage = samples.map(([position, color]) => ({
    position, color,
    coverage: Math.max(0, Math.min(1, (color[0] - background[0]) / (rule[0] - background[0])))
  }))
  return {
    samples: coverage,
    painted: coverage.filter(p => p.coverage > 0.5).map(p => p.position),
    weight: coverage.reduce((total, sample) => total + sample.coverage, 0)
  }
}
async function capture(label) {
  const geometry = await js(`(() => {
    const strip = document.querySelector('.sb-tabstrip')
    const tabs = [...strip.querySelectorAll('.sb-tab')].map(tab => ({
      ...tab.getBoundingClientRect().toJSON(), active: tab.classList.contains('active'), id: tab.dataset.sessionId
    }))
    return {
      dpr: devicePixelRatio, width: innerWidth, height: innerHeight, layout: strip.dataset.layout,
      strip: strip.getBoundingClientRect().toJSON(), tabs, scrollTop: strip.scrollTop, scrollLeft: strip.scrollLeft,
      clientWidth: strip.clientWidth, clientHeight: strip.clientHeight, scrollWidth: strip.scrollWidth, scrollHeight: strip.scrollHeight,
      barWidth: getComputedStyle(strip, '::-webkit-scrollbar').width, barDisplay: getComputedStyle(strip, '::-webkit-scrollbar').display,
      edgeFade: parseFloat(getComputedStyle(strip).getPropertyValue('--tab-edge')),
      background: getComputedStyle(strip).backgroundColor.match(/\\d+/g).map(Number),
      rule: getComputedStyle(strip.querySelector('.sb-tab')).borderRightColor.match(/\\d+/g).map(Number), errors: window.auditErrors
    }
  })()`)
  const response = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' })
  const image = nativeImage.createFromBuffer(Buffer.from(response.data, 'base64'))
  const bitmap = pixelsOf(image), scale = geometry.dpr
  check(Math.abs(bitmap.width - geometry.width * scale) <= Math.ceil(scale), label + ': screenshot/DPR mismatch')
  const { strip, tabs, background, rule } = geometry
  const referenceInset = geometry.layout === 'scroll' ? geometry.edgeFade + 3 : 4
  const verticalTab = tabs.find(tab => tab.top >= strip.top - 0.05 && tab.bottom <= strip.bottom + 0.05 &&
    tab.right > strip.left + referenceInset && tab.right < strip.right - referenceInset && tab.top + 6 < geometry.height)
  assert(verticalTab, label + ': fixture needs a visible vertical border')
  const borderX = verticalTab.right, borderY = Math.floor((verticalTab.top + 6) * scale)
  const fromX = Math.floor((borderX - 3) * scale), toX = Math.ceil((borderX + 3) * scale)
  const vertical = profile(Array.from({ length: toX - fromX + 1 }, (_, i) => [fromX + i, bitmap.at(fromX + i, borderY)]), background, rule)
  check(vertical.painted.length > 0, label + ': absent native vertical reference')
  const bottoms = []
  for (const tab of tabs) if (!bottoms.some(y => Math.abs(y - tab.bottom) < 0.05)) bottoms.push(tab.bottom)
  const rows = []
  for (const bottom of bottoms) {
    if (bottom > strip.bottom + 0.05 || bottom > geometry.height - 3 || bottom <= strip.top + 3) continue
    const inRow = tabs.filter(tab => Math.abs(tab.bottom - bottom) < 0.05)
    const tab = inRow.find(tab => !tab.active && tab.left + 12 > strip.left + 1 && tab.left + 12 < strip.right - 1)
    if (!tab) continue
    const fromY = Math.floor((bottom - 3) * scale), toY = Math.ceil((bottom + 3) * scale)
    const sampleAt = x => profile(Array.from({ length: toY - fromY + 1 }, (_, i) => [fromY + i, bitmap.at(Math.floor(x * scale), fromY + i)]), background, rule)
    const inside = sampleAt(tab.left + 12)
    const emptyX = strip.right - 4
    const empty = Math.max(...inRow.map(tab => tab.right)) + 4 < emptyX ? sampleAt(emptyX) : null
    check(inside.painted.length > 0, label + ': absent horizontal divider')
    check(inside.painted.length === vertical.painted.length, label + ': horizontal/vertical weight differs')
    // Include partially blended pixels; exact-color counts alone can miss a heavier aliased edge.
    const tolerance = 2 / Math.abs(rule[0] - background[0])
    check(Math.abs(inside.weight - vertical.weight) <= tolerance, label + ': horizontal/vertical blended weight differs')
    if (empty) {
      check(inside.samples.every((sample, index) =>
        sample.position === empty.samples[index].position && sample.coverage === empty.samples[index].coverage
      ), label + ': filled/empty divider profiles differ')
    }
    rows.push({ bottom, inside, empty })
  }
  check(rows.length > 0, label + ': fixture sampled no horizontal dividers')
  if (geometry.layout === 'wrap') {
    check(geometry.scrollHeight === geometry.clientHeight, label + ': wrapped strip still scrolls vertically')
    check(geometry.scrollWidth === geometry.clientWidth, label + ': wrapped strip overflows horizontally')
    check(Math.abs(strip.width - geometry.clientWidth) <= 0.51, label + ': wrapped strip reserves a scrollbar gutter')
    check(Math.abs(strip.height - (Math.max(...tabs.map(tab => tab.bottom)) - Math.min(...tabs.map(tab => tab.top)))) <= 0.1,
      label + ': wrapped strip clips tab rows or preserves stale height')
  } else {
    check(geometry.scrollHeight === geometry.clientHeight, label + ': horizontal strip overflows vertically')
    check(geometry.scrollWidth > geometry.clientWidth, label + ': horizontal overflow fixture does not overflow')
    check(geometry.barDisplay === 'none' || geometry.barWidth === '0px', label + ': horizontal scrollbar is visible')
  }
  check(geometry.errors.length === 0, label + ': renderer errors: ' + geometry.errors.join('; '))
  const result = { label, zoom: win.webContents.getZoomFactor(), level: win.webContents.getZoomLevel(), geometry, vertical, rows }
  results.push(result)
  writeFileSync(join(output, label + '.png'), image.toPNG())
  console.log(JSON.stringify({ label, zoom: result.zoom, dpr: geometry.dpr, rowCount: bottoms.length,
    rowPixels: rows.map(row => row.inside.painted.length), verticalPixels: vertical.painted.length,
    client: [geometry.clientWidth, geometry.clientHeight], content: [geometry.scrollWidth, geometry.scrollHeight] }))
  return result
}

app.whenReady().then(async () => {
  const deadline = setTimeout(() => { console.error('Tab renderer check timed out'); app.exit(1) }, 120000)
  try {
    win = new BrowserWindow({ width: 850, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
    const menu = Menu.buildFromTemplate([{ label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }] }])
    Menu.setApplicationMenu(menu)
    await win.loadFile(join(output, 'index.html'))
    win.webContents.debugger.attach('1.3')
    const [resetZoom, zoomIn] = menu.items[0].submenu.items
    const reset = async () => { resetZoom.click({}, win, win.webContents); await settle() }
    const zoom = async () => { zoomIn.click({}, win, win.webContents); await settle() }
    for (const theme of ['light', 'dark']) {
      win.setContentSize(850, 850)
      await configure({ theme, count: 8, layout: 'wrap', activeIndex: 6 })
      await reset()
      for (let step = 0; step <= 8; step++) {
        if (step) await zoom()
        assert(Math.abs(win.webContents.getZoomFactor() - 1.2 ** (step / 2)) < 1e-8, 'native menu zoom factor')
        await capture(`${theme}-zoom-${step}`)
      }
      await reset()
      for (let step = 0; step < 4; step++) await zoom()
      await configure({ count: 18, activeIndex: 0 })
      await capture(`${theme}-many-wrap`)
      await js(`for (let i = 0; i < 16; i++) document.querySelector('.sb-tab-close').click()`)
      await settle()
      const closed = await capture(`${theme}-closed-to-two`)
      assert.equal(closed.geometry.tabs.length, 2, 'fixture actually closed tabs')
      await configure({ count: 18, layout: 'scroll' })
      await js(`document.querySelector('.sb-tabstrip').scrollLeft = 340`)
      await settle()
      const scrolled = await capture(`${theme}-horizontal-scrolled`)
      assert(scrolled.geometry.scrollLeft > 300, 'fixture actually scrolled')
      await configure({ count: 2, layout: 'wrap' })
      await capture(`${theme}-back-to-wrap`)
      await reset()
      await configure({ count: 8, activeIndex: 0 })
      for (const width of [560, 470, 450, 470, 560, 850]) {
        win.setContentSize(width, 850)
        await settle()
        await capture(`${theme}-resize-${width}-${results.length}`)
      }
    }
    const drag = await checkDragScrolling(win)
    failures.push(...drag.failures)
    writeFileSync(join(output, 'drag-results.json'), JSON.stringify(drag, null, 2))
    writeFileSync(join(output, 'results.json'), JSON.stringify({ results, failures }, null, 2))
    if (failures.length) console.error('Tab renderer failures:\n' + [...new Set(failures)].join('\n'))
    else console.log('PASS actual tab rendering across both themes, native zoom steps, resizing, closing, layout changes, and drag scrolling')
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
