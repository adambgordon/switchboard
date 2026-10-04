const { app, BrowserWindow, nativeImage } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const installRailHelpers = require('./rail-page-helpers.cjs')

// Native regression checks for the rail: the real Sidebar in a fixed-height column, driven by real
// pointer input (CDP Input.dispatchMouseEvent), in both themes and at several native zoom steps.
// RAIL_CHECKS=1,5,9 runs a subset, by number or by name (RAIL_CHECKS=pencil).

const output = process.argv[2]
app.setPath('userData', join(output, 'profile'))
app.commandLine.appendSwitch('force-color-profile', 'srgb')
const ONLY = new Set((process.env.RAIL_CHECKS || '').split(',').map((s) => s.trim()).filter(Boolean))
const THEMES = ['light', 'dark']
const DRAG_ZOOMS = [0, 0.5]
const GEOMETRY_ZOOMS = [-0.5, 0, 0.5]
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const ringRows = []
const harnessNotes = []
let win, dbg, ctx = {}, shotIndex = 0
const js = (code) => win.webContents.executeJavaScript(code)
const call = (fn, ...args) => js(`window.__rail.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`)

async function frames(n = 2) {
  for (let i = 0; i < n; i++) await js('new Promise((resolve) => requestAnimationFrame(resolve))')
}
async function settle(ms = 60) {
  await js('document.fonts.ready')
  await frames(2)
  await delay(ms)
}
async function configure(config) {
  await js(`window.configure(${JSON.stringify(config)})`)
  await settle()
}
async function screenshot(name) {
  const response = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' })
  const image = nativeImage.createFromBuffer(Buffer.from(response.data, 'base64'))
  const file = `${String(++shotIndex).padStart(3, '0')}-${name.replace(/[^\w.-]+/g, '_')}.png`
  writeFileSync(join(output, file), image.toPNG())
  const size = image.getSize(), bytes = image.toBitmap()
  return { file, width: size.width, height: size.height, at(x, y) {
    x = Math.max(0, Math.min(size.width - 1, x)); y = Math.max(0, Math.min(size.height - 1, y))
    const i = (y * size.width + x) * 4
    return [bytes[i + 2], bytes[i + 1], bytes[i]]
  } }
}

// ---- pointer ----
// CDP's coordinate space is compared against the page's own clientX once per zoom step, so points
// measured with getBoundingClientRect land where they were measured whatever the zoom does.
const pointer = { x: 0, y: 0, down: false, scale: 1 }
async function send(type, x, y, extra = {}) {
  const held = type === 'mousePressed' || (type !== 'mouseReleased' && pointer.down)
  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type, x: x / pointer.scale, y: y / pointer.scale, button: held || type === 'mouseReleased' ? 'left' : 'none',
    buttons: held ? 1 : 0, clickCount: type === 'mouseMoved' || type === 'mouseWheel' ? 0 : 1, ...extra
  })
  if (type !== 'mouseWheel') { pointer.x = x; pointer.y = y }
}
async function calibrate() {
  for (let attempt = 0; attempt < 4; attempt++) {
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 180 + attempt, y: 300, button: 'none', buttons: 0 })
    await frames(2)
    const seen = await js('window.lastPointer')
    if (seen && seen.type === 'pointermove' && Math.abs(seen.y) > 1) {
      pointer.scale = seen.y / 300
      return pointer.scale
    }
  }
  throw new Error('harness: pointer calibration saw no pointermove')
}
async function hover(x, y) {
  // The first synthetic event after a while is sometimes not delivered: approach, then confirm.
  for (let attempt = 0; attempt < 4; attempt++) {
    await send('mouseMoved', x, y - 2)
    await send('mouseMoved', x, y)
    await frames(1)
    const seen = await js('window.lastPointer')
    if (seen && Math.abs(seen.x - x) < 1.5 && Math.abs(seen.y - y) < 1.5) return
    if (attempt) harnessNotes.push(`${label()}: hover retry ${attempt}`)
  }
  throw new Error(`harness: hover at ${x.toFixed(1)},${y.toFixed(1)} never reached the page`)
}
async function press(x, y) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await hover(x, y)
    const before = await js('window.pointerDowns')
    pointer.down = true
    await send('mousePressed', x, y)
    await frames(1)
    if ((await js('window.pointerDowns')) > before) return
    harnessNotes.push(`${label()}: press not delivered, retry ${attempt + 1}`)
    await send('mouseReleased', x, y)
    pointer.down = false
    await frames(1)
  }
  throw new Error('harness: press never reached the page')
}
async function moveTo(x, y, step = 6) {
  const dx = x - pointer.x, dy = y - pointer.y
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step))
  const x0 = pointer.x, y0 = pointer.y
  for (let i = 1; i <= n; i++) {
    await send('mouseMoved', x0 + (dx * i) / n, y0 + (dy * i) / n)
    await frames(1)
  }
}
async function escapeKey() {
  const before = await js('window.escapes')
  for (const type of ['keyDown', 'keyUp']) {
    await dbg.sendCommand('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  }
  await frames(2)
  if ((await js('window.escapes')) <= before) throw new Error('harness: the Escape key never reached the page')
}
async function release() {
  if (!pointer.down) return
  await send('mouseReleased', pointer.x, pointer.y)
  pointer.down = false
  await frames(2)
}
async function park() {
  await release()
  await send('mouseMoved', 345, 60)
  await frames(1)
}

// ---- bookkeeping ----
const label = () => `${ctx.check ?? '-'}/${ctx.theme ?? '-'}/z${ctx.zoom ?? '-'}`
function record(check, failures, details) {
  results.push({ check, theme: ctx.theme, zoom: ctx.zoom, pass: failures.length === 0, failures, details })
  const tag = failures.length ? 'FAIL' : 'pass'
  console.log(`${tag} ${check} ${ctx.theme} z${ctx.zoom}${failures.length ? ' :: ' + failures.join(' | ') : ''}`)
}
async function reset(config = {}) {
  await park()
  await js('window.reset()')
  await configure({ theme: ctx.theme, ...config })
  await settle(40)
}
const clean = (state) => !state.dragging && state.clones === 0 && state.hidden.length === 0 && state.transformed.length === 0
async function waitClean(ms = 900) {
  const start = Date.now()
  let state
  do {
    state = await call('state')
    if (clean(state)) return state
    await delay(50)
  } while (Date.now() - start < ms)
  return state
}
async function waitScrollStable(ms = 1200) {
  const start = Date.now()
  let last = (await call('box')).scrollTop, still = 0
  while (Date.now() - start < ms) {
    await delay(60)
    const now = (await call('box')).scrollTop
    if (Math.abs(now - last) < 0.01) { if (++still >= 3) return now } else still = 0
    last = now
  }
  return last
}

// The drop index for a unit's center, from its block's slots at drag start (content coordinates). The
// same rule the rail uses: the center, held within the block, passes the midpoint of every sibling
// above the gap. Returns the margin to the nearest midpoint too, so a borderline target can be nudged.
function oracle(slots, from, center) {
  const first = slots[0], last = slots[slots.length - 1]
  const held = Math.max(first.top, Math.min(last.top + last.height, center))
  let index = 0, margin = Infinity
  slots.forEach((s, i) => {
    if (i === from) return
    const mid = s.top + s.height / 2
    if (held > mid) index++
    margin = Math.min(margin, Math.abs(held - mid))
  })
  return { index, margin, held }
}
function moved(keys, from, to) {
  const next = keys.slice()
  const [k] = next.splice(from, 1)
  next.splice(to, 0, k)
  return { order: next, higher: next[to - 1] ?? null, lower: next[to + 1] ?? null }
}
// A viewport-y center that lands squarely inside the gap zone for index `to` (between the two
// midpoints that bound it), for a unit dragged from `from`.
function centerFor(slots, from, to) {
  const mids = slots.map((s) => s.top + s.height / 2).filter((_, i) => i !== from)
  const lo = to === 0 ? slots[0].top : mids[to - 1]
  const hi = to === mids.length ? slots[slots.length - 1].top + slots[slots.length - 1].height : mids[to]
  return lo + (hi - lo) * (to === mids.length ? 0.35 : 0.45)
}

/**
 * A full drag of one unit of `block` from index `from`: press on its handle, move so its center lands
 * in index `to`'s zone (or follow `path`), inspect the drag mid-flight, release, and check the commit.
 * Returns the observations; pushes failures.
 */
async function dragUnit({ block, from, to, failures, name, farPast = false, offset = 90 }) {
  const units0 = await call('units', block)
  if (units0.length < 2) throw new Error(`harness: block ${block} has ${units0.length} units`)
  const key = units0[from].key
  await call('reveal', block, key, offset)
  await settle(30)
  const b = await call('box')
  const slots = await call('units', block)
  const keys = slots.map((s) => s.key)
  const handle = (await call('unitRect', block, key)).handle
  const px = handle.left + Math.min(60, handle.width / 3), py = handle.top + Math.min(handle.height / 2, 12)
  const startCenter = slots[from].top + slots[from].height / 2
  let targetY
  if (farPast) targetY = b.bottom - 40
  else targetY = py + (centerFor(slots, from, to) - startCenter)
  if (targetY > b.bottom - 34 || targetY < b.top + 34) throw new Error(`harness: ${name} target ${targetY.toFixed(1)} falls in an edge band (${b.top.toFixed(1)}–${b.bottom.toFixed(1)})`)
  let started = false
  for (let attempt = 0; attempt < 2 && !started; attempt++) {
    await press(px, py)
    await moveTo(px, py + Math.sign(targetY - py) * 12, 4)
    await frames(1)
    started = (await call('state')).dragging
    if (!started) {
      harnessNotes.push(`${label()}: ${name}: drag did not start on attempt ${attempt + 1}`)
      await release()
      await delay(100)
    }
  }
  if (!started) { failures.push(`${name}: a 12px pointer drag on the handle did not start a drag`); return null }
  await moveTo(px, targetY)
  await frames(2)
  const mid = await call('state')
  const gap = await call('gapIndex', block, from)
  const expect = oracle(slots, from, startCenter + (targetY - py) + (mid.scrollTop - b.scrollTop))
  const shot = await screenshot(`${label()}-${name}-mid`)
  if (mid.clones !== 1) failures.push(`${name}: expected one .sb-drag-clone mid-drag, saw ${mid.clones}`)
  if (!mid.clonesHosted) failures.push(`${name}: clone is not a fixed element in a .sb-drag-host under <body>`)
  if ((await call('visibility', block, key)) !== 'hidden') failures.push(`${name}: the dragged unit is not visibility:hidden`)
  if (gap.index !== expect.index) failures.push(`${name}: gap shows index ${gap.index}, expected ${expect.index}`)
  if (!farPast && expect.index !== to) failures.push(`harness: ${name} oracle index ${expect.index} != planned ${to}`)
  const outside = mid.transformed.filter((t) => !keys.includes(t.split(':')[0]))
  if (outside.length) failures.push(`${name}: units outside block ${block} were translated: ${outside.join(', ')}`)
  const extra = { mid, gap, shot: shot.file }
  await release()
  await delay(350)
  const after = await waitClean()
  const calls = await js('window.dropCalls')
  const want = moved(keys, from, expect.index)
  const order = await js('window.order()')
  extra.after = after
  extra.calls = calls
  if (expect.index === from) {
    if (calls.length) failures.push(`${name}: released in place but got drop calls ${JSON.stringify(calls)}`)
  } else {
    if (calls.length !== 1) failures.push(`${name}: expected one drop call, got ${JSON.stringify(calls)}`)
    else {
      const c = calls[0]
      if (c.block !== block || c.dragged !== key || c.higher !== want.higher || c.lower !== want.lower) {
        failures.push(`${name}: drop call ${JSON.stringify(c)} != {block:${block}, dragged:${key}, higher:${want.higher}, lower:${want.lower}}`)
      }
    }
    const shown = block === 'folders' ? order.groups : order.blocks.find((x) => x.id === block)?.rows
    if (JSON.stringify(shown) !== JSON.stringify(want.order)) failures.push(`${name}: rendered order ${JSON.stringify(shown)} != ${JSON.stringify(want.order)}`)
  }
  if (!clean(after)) failures.push(`${name}: drag state not cleaned up 900ms after release: ${JSON.stringify(after)}`)
  if (after.errors.length) failures.push(`${name}: renderer errors: ${after.errors.join('; ')}`)
  return { key, keys, expect, want, order, ...extra }
}

// The folder clone's header must be painted and its label on screen: count label-box pixels that read
// as ink rather than the header's paper.
async function checkCloneHead(shot, name, failures) {
  const h = await call('cloneHead')
  if (!h) { failures.push(`${name}: the folder clone has no header`); return null }
  if (h.visibility !== 'visible' || h.opacity < 0.99 || h.head.height < 10) {
    failures.push(`${name}: the folder clone's header is not painted (${JSON.stringify(h)})`)
    return { text: h.text }
  }
  const s = shot.width / (await js('innerWidth'))
  const pixels = []
  for (let y = Math.ceil(h.label.top * s); y < Math.floor(h.label.bottom * s); y++) {
    for (let x = Math.ceil(h.label.left * s); x < Math.floor(Math.min(h.label.right, h.label.left + 80) * s); x++) pixels.push(shot.at(x, y))
  }
  // The paper is the box's most common color (the header's computed background can be transparent);
  // ink is what differs from it clearly. A label that isn't painted leaves the box one flat color.
  const counts = new Map()
  for (const c of pixels) { const k = c.join(); counts.set(k, (counts.get(k) ?? 0) + 1) }
  const paper = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number)
  const total = pixels.length
  const inked = pixels.filter((c) => Math.abs(c[0] - paper[0]) + Math.abs(c[1] - paper[1]) + Math.abs(c[2] - paper[2]) > 90).length
  if (inked < Math.max(20, total * 0.04) || inked > total * 0.6) failures.push(`${name}: the folder clone's header label is not visible on screen (${inked}/${total} ink pixels)`)
  return { text: h.text, inked, total }
}

// ---- checks ----
const CHECKS = {}

CHECKS['1-folders-unpinned'] = async () => {
  const failures = []
  await reset({ mode: 'folders' })
  const two = await dragUnit({ block: 'un:/home/dev/projects/atlas', from: 1, to: 3, failures, name: 'two-down' })
  // Dragged far past its folder: it stops at its block's end, never another folder's.
  await reset({ mode: 'folders' })
  const far = await dragUnit({ block: 'un:/home/dev/projects/beacon', from: 1, to: 4, failures, name: 'far-past', farPast: true, offset: 40 })
  if (far) {
    const blocks = far.order.blocks.filter((x) => x.rows.includes(far.key)).map((x) => x.id)
    if (blocks.join() !== 'un:/home/dev/projects/beacon') failures.push(`far-past: ${far.key} rendered in ${blocks.join(', ')}`)
    if (far.expect.index !== far.keys.length - 1) failures.push(`harness: far-past pointer never reached the block's end (index ${far.expect.index})`)
  }
  record('1-folders-unpinned', failures, { two: two && summary(two), far: far && summary(far) })
}

CHECKS['2-folders-pinned'] = async () => {
  const failures = []
  await reset({ mode: 'folders' })
  const unBefore = (await js('window.order()')).blocks.find((b) => b.id === 'un:/home/dev/projects/atlas').rows
  const r = await dragUnit({ block: 'pin:/home/dev/projects/atlas', from: 0, to: 2, failures, name: 'pinned', offset: 40 })
  if (r) {
    const unAfter = r.order.blocks.find((b) => b.id === 'un:/home/dev/projects/atlas').rows
    if (JSON.stringify(unAfter) !== JSON.stringify(unBefore)) failures.push('pinned: the unpinned block changed')
    if (r.calls[0] && r.calls[0].blockKind !== 'pinned') failures.push('pinned: drop reported a non-pinned block')
  }
  record('2-folders-pinned', failures, r && summary(r))
}

// A folder drag folds the DRAGGED folder to its header (`sb-folded` on its section, an inline height)
// before anything is measured, holding the grabbed header under the pointer; every other folder stays
// open. The drop is planned from the slots read once the fold has settled — the dragged folder a header
// tall, its siblings full height. The folder grabbed is the fourth, placed where its fold needs no scroll
// clamp, so its header has no legitimate reason to move.
const FOLDER_KEY = '/home/dev/projects/delta'
async function folderGrab() {
  await call('reveal', 'folders', FOLDER_KEY, 60)
  await settle(30)
  const b = await call('box')
  const r = await call('unitRect', 'folders', FOLDER_KEY)
  const px = r.handle.left + Math.min(60, r.handle.width / 3), py = r.handle.top + Math.min(r.handle.height / 2, 12)
  const keys = (await call('units', 'folders')).map((u) => u.key)
  return { b, keys, from: keys.indexOf(FOLDER_KEY), headTop: r.handle.top, unitTop: r.unit.top, grab: py - r.unit.top, px, py }
}
// Mid-drag: the dragged folder is folded — `sb-folded`, an inline height equal to its header's full
// height, clipped, its rows faded out — and every other folder is untouched and open. The clone is the
// folded folder: a header's height, carrying `sb-folded`, no row showing.
function assertFolded(shape, failures, name) {
  const dragged = shape.sections.find((g) => g.key === FOLDER_KEY)
  if (!dragged) { failures.push(`${name}: the dragged folder is missing`); return }
  if (!dragged.folded) failures.push(`${name}: the dragged folder lacks sb-folded`)
  if (!dragged.inlineHeight || dragged.height - dragged.headFull > 1 || dragged.overflowY !== 'clip' || dragged.maxOpacity > 0.01) {
    failures.push(`${name}: the dragged folder is not folded to its header (${JSON.stringify(dragged)})`)
  }
  const touched = shape.sections.filter((g) => g.key !== FOLDER_KEY && (g.folded || g.inlineHeight || g.height - g.headFull < 10 || g.minOpacity < 0.99))
  if (touched.length) failures.push(`${name}: ${touched.length} other folders are folded or dimmed mid-drag (${JSON.stringify(touched.slice(0, 2))})`)
  if (!shape.clone) failures.push(`${name}: no clone mid-drag`)
  else {
    if (!shape.clone.folded) failures.push(`${name}: the clone lacks sb-folded`)
    if (shape.clone.rect.height - shape.clone.headFull > 1) failures.push(`${name}: the clone is ${shape.clone.rect.height.toFixed(1)}px tall, more than its header (${shape.clone.headFull.toFixed(1)})`)
    if (shape.clone.shown.length) failures.push(`${name}: the folder clone still shows ${shape.clone.shown.length} blocks/more-rows`)
  }
}
// The rail open again: no folded folder, no inline heights, no fold still running, rows opaque and laid out.
function assertUnfolded(shape, failures, name) {
  const folded = shape.sections.filter((g) => g.folded)
  if (folded.length) failures.push(`${name}: ${folded.length} folders still carry sb-folded (${folded[0].key})`)
  const pinned = shape.sections.filter((g) => g.inlineHeight)
  if (pinned.length) failures.push(`${name}: ${pinned.length} folders keep an inline height (${pinned[0].key}: ${pinned[0].inlineHeight})`)
  if (shape.folds) failures.push(`${name}: ${shape.folds} fold animations still running`)
  const closed = shape.sections.filter((g) => g.rest > 0 && (g.height - g.headFull < 10 || g.minOpacity < 0.99))
  if (closed.length) failures.push(`${name}: ${closed.length} folders did not open again (${JSON.stringify(closed[0])})`)
}
// Press and cross the threshold by 6px: the drag starts and the rail folds. The fold animates for
// 180ms, so the folded layout — and the grabbed header's hold — are judged once it has settled.
async function folderStart(g, failures, name) {
  await press(g.px, g.py)
  await moveTo(g.px, g.py + 6, 3)
  await frames(1)
  const state = await call('state')
  if (!state.dragging) { failures.push(`${name}: a folder header drag did not start`); await release(); return null }
  const early = await call('folderShape')
  await delay(260)
  await frames(2)
  const shape = await call('folderShape')
  const head = await call('headTop', FOLDER_KEY)
  const b = await call('box')
  if (!early.folds && !shape.folds) harnessNotes.push(`${label()}: ${name}: no fold animation observed (reduced motion?)`)
  if (shape.folds) failures.push(`${name}: fold animations still running 260ms after the drag started`)
  assertFolded(shape, failures, name)
  if (b.scrollTop <= 0.5 || b.scrollTop >= b.maxScroll - 0.5) failures.push(`harness: ${name} folded scroll ${b.scrollTop.toFixed(1)} sits at a limit (0–${b.maxScroll.toFixed(1)}), so the header hold can't be judged`)
  const drift = head.head - g.headTop
  if (Math.abs(drift) > 2) failures.push(`${name}: the grabbed header moved ${drift.toFixed(2)}px on screen when its folder folded`)
  const cloneDrift = shape.clone ? shape.clone.rect.top - (g.unitTop + (pointer.y - g.py)) : null
  if (cloneDrift === null || Math.abs(cloneDrift) > 2) failures.push(`${name}: the clone is ${cloneDrift?.toFixed(2)}px off the pointer's grab point`)
  return { state, shape, b, earlyFolds: early.folds, drift: +drift.toFixed(2), cloneDrift: cloneDrift === null ? null : +cloneDrift.toFixed(2) }
}

CHECKS['3-folder-header'] = async () => {
  const failures = []
  const details = {}
  // Committed: one slot down, planned from the collapsed slots.
  await reset({ mode: 'folders' })
  let g = await folderGrab()
  let started = await folderStart(g, failures, 'folder')
  if (started) {
    const slots = await call('units', 'folders')
    const keys = slots.map((u) => u.key), from = keys.indexOf(FOLDER_KEY), to = from + 1
    const h = slots[from].height
    const b = await call('box')
    const centerAt = (y, scroll) => y - b.top + scroll - g.grab + h / 2
    const targetY = centerFor(slots, from, to) - h / 2 + g.grab - b.scrollTop + b.top
    const cloneTopAt = targetY - g.grab
    if (cloneTopAt < b.top + 30 || cloneTopAt + h > b.bottom - 30) failures.push(`harness: folder target puts the clone in an edge band (${cloneTopAt.toFixed(1)})`)
    await moveTo(g.px, targetY, 4)
    await frames(2)
    const scroll = (await call('box')).scrollTop
    if (Math.abs(scroll - b.scrollTop) > 0.5) failures.push(`folder: the rail scrolled ${(scroll - b.scrollTop).toFixed(1)}px with the clone clear of both edge bands`)
    const expect = oracle(slots, from, centerAt(pointer.y, scroll))
    const gap = await call('gapIndex', 'folders', from)
    if (expect.index !== to) failures.push(`harness: folder oracle index ${expect.index} != planned ${to}`)
    if (gap.index !== expect.index) failures.push(`folder: gap shows index ${gap.index}, expected ${expect.index}`)
    const shot = await screenshot(`${label()}-folder-mid`)
    const cloneHead = await checkCloneHead(shot, 'folder', failures)
    const midShape = await call('folderShape')
    assertFolded(midShape, failures, 'folder (at target)')
    // Where the dragged folder lands: the collapsed slot the gap shows — the moved siblings' bottom less
    // its own height. The clone itself floats wherever the pointer put it, up to half a slot away.
    const landing = slots[to].top + slots[to].height - h - scroll + b.top
    const releasedAt = midShape.clone ? midShape.clone.rect.top : null
    await release()
    await delay(450)
    const after = await waitClean()
    const shape = await call('folderShape')
    const head = await call('headTop', FOLDER_KEY)
    const calls = await js('window.dropCalls')
    const want = moved(keys, from, expect.index)
    const model = await js('window.modelOrder()')
    const order = await js('window.order()')
    assertUnfolded(shape, failures, 'folder (after drop)')
    if (calls.length !== 1 || calls[0].block !== 'folders' || calls[0].dragged !== FOLDER_KEY || calls[0].higher !== want.higher || calls[0].lower !== want.lower) {
      failures.push(`folder: drop calls ${JSON.stringify(calls)} != one {dragged:${FOLDER_KEY}, higher:${want.higher}, lower:${want.lower}}`)
    }
    if (JSON.stringify(model.groups) !== JSON.stringify(want.order)) failures.push(`folder: model order ${JSON.stringify(model.groups)} != ${JSON.stringify(want.order)}`)
    if (JSON.stringify(order.groups) !== JSON.stringify(want.order)) failures.push('folder: rendered folder order differs from the model')
    const landed = head.section - landing
    if (Math.abs(landed) > 2) failures.push(`folder: after expanding, the dropped folder sits ${landed.toFixed(2)}px from where it landed`)
    if (!clean(after)) failures.push(`folder: drag state not cleaned up: ${JSON.stringify(after)}`)
    if (after.errors.length) failures.push(`folder: renderer errors: ${after.errors.join('; ')}`)
    details.commit = { held: started.drift, clone: started.cloneDrift, foldedScroll: +started.b.scrollTop.toFixed(1),
      landing: expect.index, gap: gap.index, landedDrift: +landed.toFixed(2),
      cloneReleaseToLanding: releasedAt === null ? null : +(releasedAt - landing).toFixed(2), cloneHead, shot: shot.file }
  }

  // Released in its own slot: the rail expands back to the scroll it started from, and nothing commits.
  await reset({ mode: 'folders' })
  g = await folderGrab()
  started = await folderStart(g, failures, 'in-place')
  if (started) {
    await moveTo(g.px, g.py, 3)
    await frames(2)
    await release()
    await delay(450)
    const after = await waitClean()
    const shape = await call('folderShape')
    const scroll = (await call('box')).scrollTop
    assertUnfolded(shape, failures, 'in-place')
    if (Math.abs(scroll - g.b.scrollTop) > 0.5) failures.push(`in-place: scrollTop ${scroll.toFixed(1)} != drag-start ${g.b.scrollTop.toFixed(1)}`)
    if (!(await js('window.order()')).blocks.some((x) => x.id === `un:${FOLDER_KEY}`)) failures.push('in-place: the release toggled the folder closed')
    if ((await js('window.dropCalls')).length) failures.push(`in-place: a release in place committed ${JSON.stringify(await js('window.dropCalls'))}`)
    if (!clean(after)) failures.push(`in-place: drag state not cleaned up: ${JSON.stringify(after)}`)
    details.inPlace = { held: started.drift, startScroll: g.b.scrollTop, endScroll: scroll }
  }

  // Cancelled mid-drag by a density change: the same restoration, and the release commits nothing.
  await reset({ mode: 'folders' })
  g = await folderGrab()
  started = await folderStart(g, failures, 'cancel')
  if (started) {
    await moveTo(g.px, g.py + 40, 4)
    await configure({ density: 'spacious' })
    await delay(350) // the rows fade back in over --dur-fast
    const cancelled = await call('state')
    const shape = await call('folderShape')
    const scroll = (await call('box')).scrollTop
    assertUnfolded(shape, failures, 'cancel')
    if (Math.abs(scroll - g.b.scrollTop) > 0.5) failures.push(`cancel: scrollTop ${scroll.toFixed(1)} != drag-start ${g.b.scrollTop.toFixed(1)}`)
    if (!clean(cancelled)) failures.push(`cancel: drag state not cleaned up: ${JSON.stringify(cancelled)}`)
    await release()
    await delay(300)
    if ((await js('window.dropCalls')).length) failures.push(`cancel: the cancelled folder drag committed ${JSON.stringify(await js('window.dropCalls'))}`)
    details.cancel = { startScroll: g.b.scrollTop, endScroll: scroll }
  }
  record('3-folder-header', failures, details)
}

CHECKS['4-all-mode'] = async () => {
  const failures = []
  await reset({ mode: 'all' })
  const un = await dragUnit({ block: 'un:*', from: 3, to: 5, failures, name: 'all-unpinned', offset: 100 })
  await reset({ mode: 'all' })
  const pin = await dragUnit({ block: 'pin:*', from: 1, to: 3, failures, name: 'all-pinned', offset: 60 })
  record('4-all-mode', failures, { unpinned: un && summary(un), pinned: pin && summary(pin) })
}

CHECKS['5-autoscroll'] = async () => {
  const failures = []
  // Spacious, so the tall folder's block outlasts 1.5s of edge scrolling: the rail stops scrolling
  // once the dragged row's block has fully come into view, and a compact 25-row block does after ~200px.
  await reset({ mode: 'folders', density: 'spacious' })
  const block = 'un:/home/dev/projects/atlas'
  const b0 = await call('box')
  const slots = await call('units', block)
  const keys = slots.map((s) => s.key)
  const from = 0
  const blockEnd = slots[slots.length - 1].top + slots[slots.length - 1].height - b0.clientHeight
  const handle = (await call('unitRect', block, keys[from])).handle
  const px = handle.left + 60, py = handle.top + handle.height / 2
  await press(px, py)
  await moveTo(px, py + 12, 4)
  if (!(await call('state')).dragging) { failures.push('autoscroll: drag did not start'); await release(); return record('5-autoscroll', failures, {}) }
  await moveTo(px, b0.bottom - 8, 8)
  const t0 = Date.now(), s0 = (await call('box')).scrollTop
  await delay(400)
  const sEarly = (await call('box')).scrollTop
  const rate = ((sEarly - s0) / (Date.now() - t0)) * 1000
  await delay(1100)
  const s1 = (await call('box')).scrollTop
  const midShot = await screenshot(`${label()}-autoscroll-held`)
  // Leave the band and let the scroll stop, then make sure the target is not on a slot boundary.
  await moveTo(px, b0.bottom - 110, 8)
  let s2 = await waitScrollStable()
  const centerAt = (y, s) => slots[from].top + slots[from].height / 2 + (y - py) + (s - b0.scrollTop)
  let expect = oracle(slots, from, centerAt(pointer.y, s2))
  if (expect.margin < 4) {
    await moveTo(px, pointer.y + 8, 4)
    s2 = await waitScrollStable()
    expect = oracle(slots, from, centerAt(pointer.y, s2))
    harnessNotes.push(`${label()}: autoscroll target nudged off a slot boundary`)
  }
  const gap = await call('gapIndex', block, from)
  if (gap.index !== expect.index) failures.push(`autoscroll: after scrolling the gap shows index ${gap.index}, expected ${expect.index}`)
  if (s1 - s0 < Math.min(250, blockEnd - s0 - 2)) failures.push(`autoscroll: held 1.5s in the bottom band, scrollTop rose only ${(s1 - s0).toFixed(1)}px (block end at ${blockEnd.toFixed(1)})`)
  if (rate < 100) failures.push(`autoscroll: only ${rate.toFixed(0)}px/s over the first 400ms in the band`)
  if (rate > 480 * 1.1) failures.push(`autoscroll: ${rate.toFixed(0)}px/s exceeds 480px/s`)
  const landing = slots[expect.index]
  const offscreen = landing.top > b0.clientHeight + b0.scrollTop
  if (!offscreen) failures.push(`harness: autoscroll landing slot ${expect.index} (top ${landing.top.toFixed(1)}) was on screen at drag start`)
  await release()
  await delay(350)
  const after = await waitClean()
  const calls = await js('window.dropCalls')
  const want = moved(keys, from, expect.index)
  const shown = (await js('window.order()')).blocks.find((x) => x.id === block)?.rows
  if (calls.length !== 1 || calls[0].dragged !== keys[from] || calls[0].higher !== want.higher || calls[0].lower !== want.lower) {
    failures.push(`autoscroll: drop calls ${JSON.stringify(calls)} != one {higher:${want.higher}, lower:${want.lower}}`)
  }
  if (JSON.stringify(shown) !== JSON.stringify(want.order)) failures.push(`autoscroll: rendered order differs from the expected drop at ${expect.index}`)
  if (!clean(after)) failures.push(`autoscroll: not cleaned up: ${JSON.stringify(after)}`)
  record('5-autoscroll', failures, { scrolled: +(s1 - s0).toFixed(1), rate: +rate.toFixed(0), blockEnd: +blockEnd.toFixed(1), finalScroll: +s2.toFixed(1),
    landing: expect.index, landingTop: +landing.top.toFixed(1), viewport: b0.clientHeight, shot: midShot.file })
}

CHECKS['6-wheel'] = async () => {
  const failures = []
  await reset({ mode: 'folders' })
  const block = 'un:/home/dev/projects/atlas'
  const b0 = await call('box')
  const slots = await call('units', block)
  const keys = slots.map((s) => s.key)
  const from = 2
  const handle = (await call('unitRect', block, keys[from])).handle
  const px = handle.left + 60, py = handle.top + handle.height / 2
  await press(px, py)
  await moveTo(px, py + 10, 4)
  if (!(await call('state')).dragging) { failures.push('wheel: drag did not start'); await release(); return record('6-wheel', failures, {}) }
  await frames(2)
  const before = await call('gapIndex', block, from)
  const s0 = (await call('box')).scrollTop
  await send('mouseWheel', pointer.x, pointer.y, { deltaX: 0, deltaY: 160 })
  const s1 = await waitScrollStable()
  await frames(2)
  const after = await call('gapIndex', block, from)
  const seen = await js('window.lastPointer')
  const center = (s) => slots[from].top + slots[from].height / 2 + (pointer.y - py) + (s - b0.scrollTop)
  let expect = oracle(slots, from, center(s1))
  const shot = await screenshot(`${label()}-wheel`)
  if (s1 - s0 < 40) failures.push(`wheel: a 160px wheel mid-drag scrolled the rail only ${(s1 - s0).toFixed(1)}px`)
  if (after.index === before.index) failures.push(`wheel: the gap stayed at ${before.index} after a ${(s1 - s0).toFixed(1)}px scroll under a still pointer`)
  if (after.index !== expect.index) failures.push(`wheel: gap at ${after.index} after the wheel, expected ${expect.index}`)
  if (Math.abs(seen.y - pointer.y) > 0.5) failures.push('harness: the pointer moved during the wheel')
  if (expect.margin < 3) {
    await moveTo(px, pointer.y + 6, 3)
    expect = oracle(slots, from, center((await call('box')).scrollTop))
    harnessNotes.push(`${label()}: wheel target nudged off a slot boundary`)
  }
  await release()
  await delay(350)
  const cleanState = await waitClean()
  const calls = await js('window.dropCalls')
  const want = moved(keys, from, expect.index)
  const shown = (await js('window.order()')).blocks.find((x) => x.id === block)?.rows
  if (calls.length !== 1 || calls[0].higher !== want.higher || calls[0].lower !== want.lower) failures.push(`wheel: drop calls ${JSON.stringify(calls)} != one {higher:${want.higher}, lower:${want.lower}}`)
  if (JSON.stringify(shown) !== JSON.stringify(want.order)) failures.push('wheel: rendered order differs from the post-scroll target')
  if (!clean(cleanState)) failures.push(`wheel: not cleaned up: ${JSON.stringify(cleanState)}`)
  record('6-wheel', failures, { scrolled: +(s1 - s0).toFixed(1), gapBefore: before.index, gapAfter: after.index, landing: expect.index, shot: shot.file })
}

CHECKS['7-cancel'] = async () => {
  const failures = []
  const details = {}
  const triggers = { mode: { mode: 'all' }, density: { density: 'spacious' }, search: { searchOpen: true } }
  for (const [name, change] of Object.entries(triggers)) {
    await reset({ mode: 'folders' })
    const block = 'un:/home/dev/projects/atlas'
    const units = await call('units', block)
    const handle = (await call('unitRect', block, units[1].key)).handle
    const px = handle.left + 60, py = handle.top + handle.height / 2
    await press(px, py)
    await moveTo(px, py + 50, 5)
    const during = await call('state')
    if (!during.dragging || during.clones !== 1) { failures.push(`${name}: drag did not start (${JSON.stringify(during)})`); await release(); continue }
    await configure(change)
    await delay(120)
    const cancelled = await call('state')
    if (!clean(cancelled)) failures.push(`${name}: not cleaned up after cancel: ${JSON.stringify(cancelled)}`)
    // The gesture continues after the cancel: it must not restart, and its release must not commit.
    await moveTo(px, pointer.y + 30, 5)
    const moving = await call('state')
    if (!clean(moving)) failures.push(`${name}: moving after the cancel revived the drag: ${JSON.stringify(moving)}`)
    await release()
    await delay(350)
    const calls = await js('window.dropCalls')
    if (calls.length) failures.push(`${name}: the cancelled gesture committed ${JSON.stringify(calls)}`)
    await screenshot(`${label()}-cancel-${name}`)
    // Back to the original layout: the next drag works.
    await configure({ mode: 'folders', density: 'compact', searchOpen: false })
    await js('window.dropCalls = []')
    const next = await dragUnit({ block, from: 1, to: 3, failures, name: `${name}-next` })
    details[name] = { cancelled: clean(cancelled), next: next && next.calls.length }
  }
  // Escape mid-drag, for a row: fully clean, scroll where the drag started, and the release that ends
  // the press — made over the very row it pressed, where an unswallowed release would click it — neither
  // commits nor selects. Then a fresh drag commits.
  {
    await reset({ mode: 'folders' })
    const block = 'un:/home/dev/projects/atlas'
    const units = await call('units', block)
    const key = units[1].key
    const handle = (await call('unitRect', block, key)).handle
    const px = handle.left + 60, py = handle.top + handle.height / 2
    const hit = await call('hitAt', px, py)
    if (hit.row !== key) failures.push(`harness: escape-row press point hits ${hit.row}, not ${key}`)
    const scroll0 = (await call('box')).scrollTop
    const selected0 = await call('selectedKey')
    await js('window.selectCalls = []')
    await press(px, py)
    await moveTo(px, py + 50, 5)
    const during = await call('state')
    if (!during.dragging) failures.push('escape-row: drag did not start')
    else {
      await escapeKey()
      await delay(120)
      const cancelled = await call('state')
      const scroll = (await call('box')).scrollTop
      if (!clean(cancelled)) failures.push(`escape-row: not cleaned up after Escape: ${JSON.stringify(cancelled)}`)
      if (Math.abs(scroll - scroll0) > 0.5) failures.push(`escape-row: scrollTop ${scroll.toFixed(1)} != drag-start ${scroll0.toFixed(1)}`)
      await moveTo(px, py, 5)
      if ((await call('hitAt', px, py)).row !== key) failures.push(`harness: escape-row release point no longer hits ${key}`)
      await release()
      await delay(250)
      const calls = await js('window.dropCalls'), selects = await js('window.selectCalls'), selected = await call('selectedKey')
      if (calls.length) failures.push(`escape-row: the release after Escape committed ${JSON.stringify(calls)}`)
      if (selects.length || selected !== selected0) failures.push(`escape-row: the release after Escape selected ${JSON.stringify(selects)} (selected ${selected}, was ${selected0})`)
      await js('window.dropCalls = []')
      const next = await dragUnit({ block, from: 1, to: 3, failures, name: 'escape-row-next' })
      details.escapeRow = { cleaned: clean(cancelled), scroll0, scroll, selects, next: next && next.calls.length }
    }
  }
  // Escape mid-drag, for a folder: the fold reverted and the scroll restored; the release over the same
  // collapse toggle does not toggle the folder; then a fresh folder drag commits.
  {
    await reset({ mode: 'folders' })
    const g = await folderGrab()
    const hit = await call('hitAt', g.px, g.py)
    if (hit.toggle !== FOLDER_KEY) failures.push(`harness: escape-folder press point misses ${FOLDER_KEY}'s collapse toggle (${JSON.stringify(hit)})`)
    const started = await folderStart(g, failures, 'escape-folder')
    if (started) {
      await moveTo(g.px, g.py + 40, 4)
      await escapeKey()
      await delay(350) // the rows fade back in over --dur-fast
      const cancelled = await call('state')
      const shape = await call('folderShape')
      const scroll = (await call('box')).scrollTop
      if (!clean(cancelled)) failures.push(`escape-folder: not cleaned up after Escape: ${JSON.stringify(cancelled)}`)
      assertUnfolded(shape, failures, 'escape-folder')
      if (Math.abs(scroll - g.b.scrollTop) > 0.5) failures.push(`escape-folder: scrollTop ${scroll.toFixed(1)} != drag-start ${g.b.scrollTop.toFixed(1)}`)
      await moveTo(g.px, g.py, 4)
      if ((await call('hitAt', g.px, g.py)).toggle !== FOLDER_KEY) failures.push('harness: escape-folder release point no longer hits the collapse toggle')
      await release()
      await delay(250)
      const calls = await js('window.dropCalls')
      const open = (await js('window.order()')).blocks.some((x) => x.id === `un:${FOLDER_KEY}`)
      if (calls.length) failures.push(`escape-folder: the release after Escape committed ${JSON.stringify(calls)}`)
      if (!open) failures.push('escape-folder: the release after Escape toggled the folder closed')
      // A fresh folder drag, one slot down, commits.
      await js('window.dropCalls = []')
      const g2 = await folderGrab()
      const again = await folderStart(g2, failures, 'escape-folder-next')
      let committed = null
      if (again) {
        const slots = await call('units', 'folders')
        const keys = slots.map((u) => u.key), from = keys.indexOf(FOLDER_KEY), to = from + 1
        const b = await call('box')
        const targetY = centerFor(slots, from, to) - slots[from].height / 2 + g2.grab - b.scrollTop + b.top
        await moveTo(g2.px, targetY, 4)
        await frames(2)
        await release()
        await delay(450)
        committed = await js('window.dropCalls')
        const want = moved(keys, from, to)
        if (committed.length !== 1 || committed[0].dragged !== FOLDER_KEY || committed[0].higher !== want.higher || committed[0].lower !== want.lower) {
          failures.push(`escape-folder-next: drop calls ${JSON.stringify(committed)} != one {higher:${want.higher}, lower:${want.lower}}`)
        }
      }
      details.escapeFolder = { cleaned: clean(cancelled), scroll0: g.b.scrollTop, scroll, open, next: committed && committed.length }
    }
  }
  // A non-empty query disables dragging outright.
  await reset({ mode: 'folders', searchOpen: true, query: 'atlas' })
  const units = await call('units', 'un:/home/dev/projects/atlas')
  const handle = (await call('unitRect', 'un:/home/dev/projects/atlas', units[1].key)).handle
  await press(handle.left + 60, handle.top + handle.height / 2)
  await moveTo(handle.left + 60, handle.top + handle.height / 2 + 50, 5)
  const searching = await call('state')
  if (searching.dragging || searching.clones) failures.push(`searching: a drag started while a query was active: ${JSON.stringify(searching)}`)
  await release()
  await delay(200)
  if ((await js('window.dropCalls')).length) failures.push('searching: a drop was committed while searching')
  details.searching = { dragging: searching.dragging, clones: searching.clones }
  record('7-cancel', failures, details)
}

CHECKS['8-menu-and-click'] = async () => {
  const failures = []
  await reset({ mode: 'folders' })
  const block = 'un:/home/dev/projects/atlas'
  const units = await call('units', block)
  const key = units[4].key
  await call('reveal', block, key, 120)
  await settle(30)
  const row = await call('rowRect', key)
  await hover(row.left + 60, row.top + row.height / 2)
  await delay(60)
  const btn = await call('menuButton', key)
  if (!btn) failures.push('menu: no ⋮ button in the row')
  else {
    if (!btn.noDrag) failures.push('menu: the ⋮ button lacks data-no-drag')
    const bx = btn.rect.left + btn.rect.width / 2, by = btn.rect.top + btn.rect.height / 2
    await press(bx, by)
    await moveTo(bx, by + 40, 4)
    const state = await call('state')
    if (state.dragging || state.clones) failures.push(`menu: pressing ⋮ and moving started a drag: ${JSON.stringify(state)}`)
    await release()
    await delay(200)
    if ((await js('window.dropCalls')).length) failures.push('menu: pressing ⋮ produced a drop call')
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
  }
  // A plain click selects.
  await park()
  await js('window.selectCalls = []')
  const target = units[6].key
  const tr = await call('rowRect', target)
  const cx = tr.left + 60, cy = tr.top + tr.height / 2
  await press(cx, cy)
  await release()
  await delay(150)
  const state = await call('state')
  const selectCalls = await js('window.selectCalls')
  const selected = await call('selectedKey')
  if (!selectCalls.includes(target)) failures.push(`click: selecting ${target} was not reported (${JSON.stringify(selectCalls)})`)
  if (selected !== target) failures.push(`click: the selected row is ${selected}, expected ${target}`)
  if (state.dragging || state.clones || state.calls) failures.push(`click: a plain click produced drag state ${JSON.stringify(state)}`)
  record('8-menu-and-click', failures, { selectCalls, selected })
}

// A folder grabbed by its STUCK header: atlas scrolled so its header is pinned to the rail's top while
// the section's own top is far above the view. The clone must sit under the pointer by the offset the
// pointer had inside the HEADER — measured on the clone's label against the real label at press — both
// once the fold settles and after a further 40px move, and the drop must land where planned.
CHECKS['10-stuck-header'] = async () => {
  const failures = []
  const KEY = '/home/dev/projects/atlas'
  await reset({ mode: 'folders' })
  await call('scrollTo', 400)
  await settle(40)
  const b0 = await call('box')
  const head0 = await call('headTop', KEY)
  if (!(head0.section < b0.top - 100 && Math.abs(head0.head - b0.top) < 10)) {
    failures.push(`harness: atlas's header is not stuck at the rail top (header ${head0.head.toFixed(1)}, section ${head0.section.toFixed(1)}, rail ${b0.top.toFixed(1)})`)
  }
  const handle = (await call('unitRect', 'folders', KEY)).handle
  const px = handle.left + Math.min(60, handle.width / 3), py = handle.top + Math.min(handle.height / 2, 12)
  const label0 = await call('headLabel', KEY)
  await press(px, py)
  await moveTo(px, py + 6, 3)
  await frames(1)
  if (!(await call('state')).dragging) { failures.push('stuck: a drag on the stuck header did not start'); await release(); return record('10-stuck-header', failures, {}) }
  await delay(260)
  await frames(2)
  const underPointer = async () => {
    const l = await call('cloneLabel')
    return l ? l.top - (label0.top + (pointer.y - py)) : null
  }
  const settled = await underPointer()
  if (settled === null || Math.abs(settled) > 2) failures.push(`stuck: after the fold settled, the clone's header sits ${settled?.toFixed(2)}px from the pointer's grab point`)
  const shot = await screenshot(`${label()}-stuck-settled`)
  const b1 = await call('box')
  const unit1 = (await call('unitRect', 'folders', KEY)).unit
  await moveTo(px, pointer.y + 40, 4)
  await frames(2)
  const moved40 = await underPointer()
  if (moved40 === null || Math.abs(moved40) > 2) failures.push(`stuck: after a further 40px move, the clone's header sits ${moved40?.toFixed(2)}px from the pointer's grab point`)
  // One slot down, planned from the settled slots and the grab measured from the folded folder's top.
  const slots = await call('units', 'folders')
  const keys = slots.map((u) => u.key), from = keys.indexOf(KEY), to = from + 1
  const h = slots[from].height
  const b = await call('box')
  if (Math.abs(b.scrollTop - b1.scrollTop) > 0.5) failures.push(`stuck: the rail scrolled ${(b.scrollTop - b1.scrollTop).toFixed(1)}px during the drag`)
  const grab = py - unit1.top
  const targetY = centerFor(slots, from, to) - h / 2 + grab - b.scrollTop + b.top
  if (targetY - grab < b.top + 30 || targetY - grab + h > b.bottom - 30) failures.push(`harness: stuck target puts the clone in an edge band (${targetY.toFixed(1)})`)
  await moveTo(px, targetY, 4)
  await frames(2)
  const expect = oracle(slots, from, pointer.y - b.top + b.scrollTop - grab + h / 2)
  const gap = await call('gapIndex', 'folders', from)
  if (expect.index !== to) failures.push(`harness: stuck oracle index ${expect.index} != planned ${to}`)
  if (gap.index !== to) failures.push(`stuck: the gap shows index ${gap.index}, planned ${to}`)
  await release()
  await delay(450)
  const after = await waitClean()
  const calls = await js('window.dropCalls')
  const want = moved(keys, from, to)
  if (calls.length !== 1 || calls[0].dragged !== KEY || calls[0].higher !== want.higher || calls[0].lower !== want.lower) {
    failures.push(`stuck: drop calls ${JSON.stringify(calls)} != one {dragged:${KEY}, higher:${want.higher}, lower:${want.lower}}`)
  }
  if (!clean(after)) failures.push(`stuck: drag state not cleaned up: ${JSON.stringify(after)}`)
  assertUnfolded(await call('folderShape'), failures, 'stuck (after drop)')
  record('10-stuck-header', failures, { settled: settled && +settled.toFixed(2), moved40: moved40 && +moved40.toFixed(2),
    foldedScroll: +b1.scrollTop.toFixed(1), gap: gap.index, shot: shot.file })
}

// A sibling changing size mid-drag makes every captured slot below it stale, so the drag cancels: a
// conversation arriving in ANOTHER folder during a folder drag (the folder grows; its element stays),
// and one arriving in the SAME block during a row drag (the membership changes).
CHECKS['11-sibling-resize'] = async () => {
  const failures = []
  const details = {}
  {
    await reset({ mode: 'folders' })
    const g = await folderGrab()
    const started = await folderStart(g, failures, 'grow-folder')
    if (started) {
      const other = '/home/dev/projects/beacon'
      const before = (await call('headTop', other)) && (await call('folderShape')).sections.find((x) => x.key === other).height
      const id = await js(`window.addConversation(${JSON.stringify(other)})`)
      await frames(2)
      await delay(350)
      const shape = await call('folderShape')
      const grown = shape.sections.find((x) => x.key === other).height
      const order = await js('window.order()')
      if (!order.blocks.find((x) => x.id === `un:${other}`)?.rows.includes(id) || grown - before < 10) {
        failures.push(`harness: beacon did not grow by a row (${before.toFixed(1)} → ${grown.toFixed(1)})`)
      }
      const state = await call('state')
      const scroll = (await call('box')).scrollTop
      if (!clean(state)) failures.push(`grow-folder: the folder drag survived another folder growing: ${JSON.stringify(state)}`)
      assertUnfolded(shape, failures, 'grow-folder')
      if (Math.abs(scroll - g.b.scrollTop) > 0.5) failures.push(`grow-folder: scrollTop ${scroll.toFixed(1)} != drag-start ${g.b.scrollTop.toFixed(1)}`)
      await moveTo(g.px, pointer.y + 60, 4)
      await release()
      await delay(300)
      const calls = await js('window.dropCalls')
      if (calls.length) failures.push(`grow-folder: the release after the cancel committed ${JSON.stringify(calls)}`)
      details.folder = { grew: +(grown - before).toFixed(1), cancelled: clean(state), scroll0: g.b.scrollTop, scroll }
    }
  }
  {
    await reset({ mode: 'folders' })
    const block = 'un:/home/dev/projects/atlas'
    const units = await call('units', block)
    const handle = (await call('unitRect', block, units[1].key)).handle
    const px = handle.left + 60, py = handle.top + handle.height / 2
    const scroll0 = (await call('box')).scrollTop
    await press(px, py)
    await moveTo(px, py + 50, 5)
    if (!(await call('state')).dragging) failures.push('grow-block: row drag did not start')
    else {
      const id = await js("window.addConversation('/home/dev/projects/atlas')")
      await frames(2)
      await delay(150)
      const rows = (await js('window.order()')).blocks.find((x) => x.id === block)?.rows ?? []
      if (!rows.includes(id)) failures.push('harness: the new conversation did not render in the dragged block')
      const state = await call('state')
      const scroll = (await call('box')).scrollTop
      if (!clean(state)) failures.push(`grow-block: the row drag survived its block gaining a row: ${JSON.stringify(state)}`)
      if (Math.abs(scroll - scroll0) > 0.5) failures.push(`grow-block: scrollTop ${scroll.toFixed(1)} != drag-start ${scroll0.toFixed(1)}`)
      await moveTo(px, pointer.y + 40, 5)
      await release()
      await delay(300)
      const calls = await js('window.dropCalls')
      if (calls.length) failures.push(`grow-block: the release after the cancel committed ${JSON.stringify(calls)}`)
      details.row = { cancelled: clean(state), scroll0, scroll }
    }
  }
  record('11-sibling-resize', failures, details)
}

// The row clone keeps the row's own padding: at the moment of lift, before any sideways movement, the
// clone's title box sits where the real row's title was — horizontally exact, vertically offset by the
// pointer's travel past the threshold only — in both densities.
CHECKS['12-clone-padding'] = async () => {
  const failures = []
  const details = {}
  for (const density of ['compact', 'spacious']) {
    await reset({ mode: 'folders', density })
    const block = 'un:/home/dev/projects/atlas'
    const units = await call('units', block)
    const key = units[2].key
    await call('reveal', block, key, 120)
    await settle(30)
    const row = await call('rowRect', key)
    const px = row.left + 60, py = row.top + row.height / 2
    await hover(px, py)
    await delay(40)
    const t0 = await call('rowTitle', key)
    await press(px, py)
    await moveTo(px, py + 5, 5)
    await frames(1)
    if (!(await call('state')).dragging) { failures.push(`${density}: row drag did not start`); await release(); continue }
    const ct = await call('cloneTitle')
    if (!ct) failures.push(`${density}: the clone has no .sb-row-title`)
    else {
      const dx = ct.left - t0.left, dy = ct.top - (t0.top + (pointer.y - py))
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) failures.push(`${density}: the clone's title moved ${dx.toFixed(2)}px across and ${dy.toFixed(2)}px down at lift`)
      details[density] = { dx: +dx.toFixed(2), dy: +dy.toFixed(2) }
    }
    await screenshot(`${label()}-clone-padding-${density}`)
    await release()
    await delay(400)
  }
  record('12-clone-padding', failures, details)
}

// A fold that CLAMPS the scroll: three folders, the tall one last, scrolled to the bottom so its header
// is stuck at the rail's top. Folding it removes the overflow, so the anchor that would hold the header
// under the pointer runs into scrollTop 0 and the real header drops down the rail. The clone must still
// sit under the pointer (its label at the real label's press position plus the pointer's travel), and the
// first slot must be reachable from inside the rail.
CHECKS['13-fold-clamp'] = async () => {
  const failures = []
  const KEY = '/home/dev/projects/atlas'
  const ONLY = ['/home/dev/projects/cinder', '/home/dev/notes', KEY]
  await reset({ mode: 'folders', only: ONLY })
  const order0 = await js('window.order()')
  if (JSON.stringify(order0.groups) !== JSON.stringify(ONLY)) failures.push(`harness: fixture folders ${JSON.stringify(order0.groups)} != ${JSON.stringify(ONLY)}`)
  await call('scrollTo', 1e9)
  await settle(40)
  const b0 = await call('box')
  const head0 = await call('headTop', KEY)
  const label0 = await call('headLabel', KEY)
  const handle = (await call('unitRect', 'folders', KEY)).handle
  const px = handle.left + Math.min(60, handle.width / 3), py = handle.top + Math.min(handle.height / 2, 12)
  await press(px, py)
  await moveTo(px, py + 6, 3)
  await frames(1)
  if (!(await call('state')).dragging) { failures.push('clamp: a drag on the last folder\'s header did not start'); await release(); return record('13-fold-clamp', failures, {}) }
  await delay(260)
  await frames(2)
  const b1 = await call('box')
  const head1 = await call('headTop', KEY)
  // What an unclamped anchor would have needed: the scroll that puts the folded header back at its press
  // position. The guard: the scroll sits at a limit short of that, or the header visibly moved.
  const needed = b1.scrollTop + (head1.head - head0.head)
  const atLimit = b1.scrollTop <= 0.5 || b1.scrollTop >= b1.maxScroll - 0.5
  const headerMoved = head1.head - head0.head
  if (!((atLimit && Math.abs(needed - b1.scrollTop) > 2) || Math.abs(headerMoved) > 2)) {
    failures.push(`harness: the fold did not clamp the scroll (scroll ${b1.scrollTop.toFixed(1)} of 0–${b1.maxScroll.toFixed(1)}, needed ${needed.toFixed(1)}, header moved ${headerMoved.toFixed(1)}px)`)
  }
  const underPointer = async () => {
    const l = await call('cloneLabel')
    return l ? l.top - (label0.top + (pointer.y - py)) : null
  }
  const settled = await underPointer()
  if (settled === null || Math.abs(settled) > 2) failures.push(`clamp: after the fold settled, the clone's header sits ${settled?.toFixed(2)}px from the pointer's grab point`)
  const shot = await screenshot(`${label()}-fold-clamp-settled`)
  await moveTo(px, pointer.y + 40, 4)
  await frames(2)
  const down40 = await underPointer()
  if (down40 === null || Math.abs(down40) > 2) failures.push(`clamp: after a further +40px move, the clone's header sits ${down40?.toFixed(2)}px from the pointer's grab point`)
  await moveTo(px, pointer.y - 40, 4)
  await frames(2)
  const up40 = await underPointer()
  if (up40 === null || Math.abs(up40) > 2) failures.push(`clamp: after moving back -40px, the clone's header sits ${up40?.toFixed(2)}px from the pointer's grab point`)
  // Onto the first slot. The pointer keeps its grip within the header, and the header its place in the
  // folded folder, so the unit's top is the pointer less both — which must bring the first slot within
  // reach of a pointer inside the rail.
  const slots = await call('units', 'folders')
  const keys = slots.map((u) => u.key), from = keys.indexOf(KEY), to = 0
  const h = slots[from].height
  const b = await call('box')
  const grab = (py - head0.head) + (head1.head - head1.section)
  const targetY = centerFor(slots, from, to) - h / 2 + grab - b.scrollTop + b.top
  if (targetY < b.top + 2 || targetY > b.bottom - 2) failures.push(`clamp: the first slot needs the pointer at ${targetY.toFixed(1)}, outside the rail (${b.top.toFixed(1)}–${b.bottom.toFixed(1)})`)
  await moveTo(px, Math.max(b.top + 2, Math.min(b.bottom - 2, targetY)), 4)
  await frames(2)
  const expect = oracle(slots, from, pointer.y - b.top + b.scrollTop - grab + h / 2)
  const gap = await call('gapIndex', 'folders', from)
  if (expect.index !== to) failures.push(`harness: clamp oracle index ${expect.index} != planned ${to}`)
  if (gap.index !== to) failures.push(`clamp: with the pointer at ${(pointer.y - b.top).toFixed(1)}px into the rail the gap shows index ${gap.index}, not the first slot`)
  await release()
  await delay(450)
  const after = await waitClean()
  const calls = await js('window.dropCalls')
  const want = moved(keys, from, to)
  if (calls.length !== 1 || calls[0].dragged !== KEY || calls[0].higher !== want.higher || calls[0].lower !== want.lower) {
    failures.push(`clamp: drop calls ${JSON.stringify(calls)} != one {dragged:${KEY}, higher:${want.higher}, lower:${want.lower}}`)
  }
  const model = await js('window.modelOrder()')
  if (JSON.stringify(model.groups) !== JSON.stringify(want.order)) failures.push(`clamp: model order ${JSON.stringify(model.groups)} != ${JSON.stringify(want.order)}`)
  if (!clean(after)) failures.push(`clamp: drag state not cleaned up: ${JSON.stringify(after)}`)
  assertUnfolded(await call('folderShape'), failures, 'clamp (after drop)')
  record('13-fold-clamp', failures, { startScroll: +b0.scrollTop.toFixed(1), foldedScroll: +b1.scrollTop.toFixed(1), needed: +needed.toFixed(1),
    headerMoved: +headerMoved.toFixed(1), settled: settled && +settled.toFixed(2), down40: down40 && +down40.toFixed(2), up40: up40 && +up40.toFixed(2),
    targetInRail: +(targetY - b.top).toFixed(1), gap: gap.index, shot: shot.file })
}

// A folder header's new-conversation actions (SidebarGroupHeader). The pencil shows while the pointer is
// anywhere in its folder; the agent logos slide out from under it while the pointer is on the pencil or a
// logo, each box abutting the next so the pointer never crosses a gap between them; a click reports the
// folder (and, on a logo, its agent); a press there never starts a folder drag; and a folder drag hides
// them on every folder and in the clone. Judged with one agent installed and with two, in both densities.
// The header around them: Compact draws no leader rule and Spacious runs it to the toggle's content edge,
// the toggle's hover fill spans the header with the pencil painting that same fill, a long name stops
// clear of the actions, and each action's tooltip names what it starts. The rail head's own
// new-conversation button is judged here too: its tooltip, and one call per click.
const PENCIL_KEY = '/home/dev/projects/atlas'
const HEAD_NEW_TIP = 'New conversation (⌘N)'
const LONG_KEY = '/home/dev/projects/prism-shared-component-library-migration-notes'
const AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex' }
// The toggle's trailing padding in Spacious, where the leader rule ends; and the least room a name
// leaves between itself and the header's edge, for the actions overlaid there.
const RULE_INSET = 8
const LABEL_CLEARANCE = 22
const TRANSPARENT = 'rgba(0, 0, 0, 0)'
// A row of each agent in the pencil's folder (the fixture gives a row Codex when its index plus its
// folder's is a multiple of three).
const TIP_ROWS = [['atlas-1', 'claude'], ['atlas-3', 'codex']]
const PENCIL_AGENT_SETS = [['claude', 'codex'], ['codex']]
const middle = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
const shown = (el) => el.opacity > 0.999 && el.pointerEvents === 'auto'
const folderDragging = (key) => js(`[...document.querySelectorAll('.sb-rail-body > section.sb-group')].some((g) => g.dataset.key === ${JSON.stringify(key)} && g.classList.contains('dragging'))`)
// Opacity and transform transition over --dur-fast / --dur: read the actions once nothing on them moves.
async function waitNewStill(ms = 1200) {
  await frames(2)
  const start = Date.now()
  do {
    if ((await call('newMotion')) === 0) return true
    await delay(30)
  } while (Date.now() - start < ms)
  harnessNotes.push(`${label()}: header actions still transitioning after ${ms}ms`)
  return false
}
// The toggle's fill transitions too: read a header once nothing in it moves.
async function waitHeadStill(key, ms = 1200) {
  await frames(2)
  const start = Date.now()
  do {
    const h = await call('headerPaint', key)
    if (h && h.motion === 0) return h
    await delay(30)
  } while (Date.now() - start < ms)
  harnessNotes.push(`${label()}: ${key}'s header still transitioning after ${ms}ms`)
  return call('headerPaint', key)
}
// The tooltip once it shows what `want` accepts, re-read a little later so a passing label must hold.
// Past the layer's show delay (450ms) with room to spare; returns the last label seen either way.
async function waitTip(want, ms = 1600) {
  await frames(2)
  const start = Date.now()
  let tip
  do {
    tip = await call('tip')
    if (tip && want(tip)) {
      await delay(150)
      return call('tip')
    }
    await delay(40)
  } while (Date.now() - start < ms)
  return tip
}

async function pencilCase(density, agents, failures) {
  const tag = `${density}/${agents.join('+')}`
  const info = { tag }
  await reset({ mode: 'folders', density, agents })
  await waitNewStill()
  let a = await call('newActions', PENCIL_KEY)
  if (!a) { failures.push(`${tag}: ${PENCIL_KEY} has no pencil`); return info }
  if (a.logos.length !== agents.length) failures.push(`${tag}: ${a.logos.length} agent logos for ${agents.length} installed agents`)
  if (a.logos.length === 0) return info

  // At rest, pointer outside every folder. Compact draws no leader rule; Spacious runs it to the toggle's
  // content edge, which is the header's edge less the toggle's padding, so the overlaid pencil does not
  // shorten it. A name long enough to truncate stops clear of the actions in both densities.
  const rest = await waitHeadStill(PENCIL_KEY)
  const long = await call('headerPaint', LONG_KEY)
  if (!rest || !long) { failures.push(`harness: ${tag}: missing header ${rest ? LONG_KEY : PENCIL_KEY}`); return info }
  for (const h of [rest, long]) {
    const which = h === rest ? PENCIL_KEY : LONG_KEY
    if (density === 'compact' && h.rule.display !== 'none') failures.push(`${tag}: Compact draws ${which}'s leader rule (::after display ${h.rule.display})`)
    if (density !== 'compact' && h.rule.display === 'none') failures.push(`${tag}: Spacious draws no leader rule on ${which}`)
  }
  if (density !== 'compact' && rest.rule.display !== 'none') {
    const toToggle = rest.rule.right - (rest.toggle.right - rest.paddingRight)
    const toHead = rest.rule.right - (rest.head.right - RULE_INSET)
    if (Math.abs(toToggle) > 1) failures.push(`${tag}: the leader rule ends ${toToggle.toFixed(2)}px from the toggle's content edge`)
    if (Math.abs(toHead) > 1) failures.push(`${tag}: the leader rule ends ${toHead.toFixed(2)}px from ${RULE_INSET}px inside the header's edge (the pencil shortens it)`)
    info.rule = { toToggle: +toToggle.toFixed(2), toHead: +toHead.toFixed(2), width: rest.rule.width }
  }
  const clearance = long.head.right - long.label.right
  if (!long.truncated) failures.push(`harness: ${tag}: ${LONG_KEY}'s name does not truncate`)
  if (clearance < LABEL_CLEARANCE - 0.5) failures.push(`${tag}: a truncated name ends ${clearance.toFixed(2)}px from the header's edge, under the actions (want >= ${LABEL_CLEARANCE}px)`)
  info.labelClearance = +clearance.toFixed(2)

  // Pointer outside every folder: no pencil shows.
  const showing = (await call('pencilOpacities')).filter((p) => p.opacity === null || p.opacity > 0.001)
  if (a.hovered) failures.push(`harness: ${tag}: the parked pointer still hovers the header actions`)
  if (showing.length) failures.push(`${tag}: pointer outside every folder, yet ${showing.length} pencils show (${JSON.stringify(showing.slice(0, 3))})`)

  // Pointer on one of the folder's rows: its pencil shows, no other folder's does, and the logos stay put away.
  const rows = await call('units', `un:${PENCIL_KEY}`)
  const row = await call('rowRect', rows[1].key)
  await hover(row.left + 60, row.top + row.height / 2)
  await waitNewStill()
  a = await call('newActions', PENCIL_KEY)
  const others = (await call('pencilOpacities')).filter((p) => p.key !== PENCIL_KEY && p.opacity > 0.001)
  if (a.pencil.opacity < 0.999) failures.push(`${tag}: pointer on a row of the folder, its pencil has opacity ${a.pencil.opacity}`)
  if (others.length) failures.push(`${tag}: pointer on a row of ${PENCIL_KEY}, other folders' pencils show (${JSON.stringify(others.slice(0, 3))})`)
  const early = a.logos.filter((l) => l.opacity > 0.001 || l.pointerEvents !== 'none')
  if (early.length) failures.push(`${tag}: pointer on a row, ${early.length} logos are out (${JSON.stringify(early.map((l) => [l.opacity, l.pointerEvents]))})`)

  // Pointer on the folder's name: the toggle's fill spans the header to its trailing edge, and the pencil
  // over that edge paints the same fill, so the fill has no hole where the pencil sits.
  const lab = rest.label
  await hover(lab.left + Math.min(20, lab.width / 2), lab.top + lab.height / 2)
  const over = await waitHeadStill(PENCIL_KEY)
  if (!over.toggleHovered) failures.push(`harness: ${tag}: the pointer on the folder's name does not hover its toggle`)
  const fillGap = over.head.right - over.toggle.right
  if (Math.abs(fillGap) > 0.5) failures.push(`${tag}: the toggle's fill ends ${fillGap.toFixed(2)}px short of the header's edge`)
  if (over.toggleBackground === TRANSPARENT) failures.push(`${tag}: the toggle has no fill while hovered`)
  if (over.pencilBackground !== over.toggleBackground) failures.push(`${tag}: the pencil paints ${over.pencilBackground} over the toggle's ${over.toggleBackground} fill`)
  if (over.pencilOpacity < 0.999) failures.push(`${tag}: pointer on the folder's name, its pencil has opacity ${over.pencilOpacity}`)
  info.fill = { gap: +fillGap.toFixed(2), toggle: over.toggleBackground, pencil: over.pencilBackground }

  // Pointer on the pencil: every logo out, each box abutting the next — the nearest against the pencil —
  // on the pencil's line, and inside the header.
  const pc = middle(a.pencil.rect)
  await hover(pc.x, pc.y)
  await waitNewStill()
  a = await call('newActions', PENCIL_KEY)
  if (!a.hovered) failures.push(`${tag}: the pointer on the pencil does not hover the header actions`)
  const onPencil = await waitHeadStill(PENCIL_KEY)
  if (onPencil.toggleBackground !== TRANSPARENT) failures.push(`${tag}: pointer on the pencil, the toggle keeps its fill (${onPencil.toggleBackground})`)
  const hidden = a.logos.filter((l) => !shown(l))
  if (hidden.length) failures.push(`${tag}: pointer on the pencil, ${hidden.length} logos not shown (${JSON.stringify(hidden.map((l) => [l.opacity, l.pointerEvents]))})`)
  const nearest = a.logos.slice().sort((x, y) => y.rect.right - x.rect.right)
  const p = a.pencil.rect
  if (p.left < a.head.left - 0.5 || p.right > a.head.right + 0.5) failures.push(`${tag}: the pencil (${p.left.toFixed(2)}–${p.right.toFixed(2)}) leaves the header (${a.head.left.toFixed(2)}–${a.head.right.toFixed(2)})`)
  let prev = p
  info.edges = []
  nearest.forEach((l, i) => {
    const r = l.rect
    const seam = r.right - prev.left
    info.edges.push(+seam.toFixed(2))
    if (Math.abs(seam) > 0.5) failures.push(`${tag}: logo ${i + 1}'s right edge sits ${seam.toFixed(2)}px from the ${i ? `logo ${i}'s` : "pencil's"} left edge`)
    if (Math.abs(r.top - p.top) > 0.5 || Math.abs(r.height - p.height) > 0.5) failures.push(`${tag}: logo ${i + 1} (top ${r.top.toFixed(2)}, height ${r.height.toFixed(2)}) is off the pencil's line (top ${p.top.toFixed(2)}, height ${p.height.toFixed(2)})`)
    if (r.left < a.head.left - 0.5 || r.right > a.head.right + 0.5) failures.push(`${tag}: logo ${i + 1} (${r.left.toFixed(2)}–${r.right.toFixed(2)}) leaves the header (${a.head.left.toFixed(2)}–${a.head.right.toFixed(2)})`)
    prev = r
  })
  if (nearest.some((l, i) => l.slot !== i + 1)) failures.push(`${tag}: logo slots nearest-first are ${JSON.stringify(nearest.map((l) => l.slot))}`)
  info.shot = (await screenshot(`${label()}-pencil-${tag}`)).file

  // From the pencil's center to the farthest logo's in steps under 2px: the logos stay out at every step.
  const lc = middle(nearest[nearest.length - 1].rect)
  const steps = Math.ceil(Math.abs(lc.x - pc.x) / 1.5)
  const drops = []
  for (let i = 1; i <= steps; i++) {
    const x = pc.x + ((lc.x - pc.x) * i) / steps
    await send('mouseMoved', x, pc.y)
    await frames(1)
    const s = await call('newActions', PENCIL_KEY)
    if (!s.hovered || !s.logos.every(shown)) drops.push({ dx: +(x - pc.x).toFixed(2), hovered: s.hovered, logos: s.logos.map((l) => [+l.opacity.toFixed(2), l.pointerEvents]) })
  }
  const seen = await js('window.lastPointer')
  if (!seen || Math.abs(seen.x - lc.x) > 1.5) failures.push(`harness: ${tag}: the walk to the last logo never reached the page`)
  if (drops.length) failures.push(`${tag}: walking from the pencil to the last logo, the logos went away at ${drops.length}/${steps} steps (first ${JSON.stringify(drops[0])})`)
  info.walk = { steps, drops: drops.length }

  // Clicks: the pencil reports the folder; each logo, nearest first, the folder and that slot's agent.
  await moveTo(pc.x, pc.y, 1.5)
  await press(pc.x, pc.y)
  await release()
  for (const l of nearest) {
    const c = middle(l.rect)
    await moveTo(c.x, c.y, 1.5)
    await press(c.x, c.y)
    await release()
  }
  await delay(80)
  const calls = await js('window.newCalls')
  const want = [{ kind: 'new', root: PENCIL_KEY }, ...agents.map((agent) => ({ kind: 'start', root: PENCIL_KEY, agent }))]
  if (JSON.stringify(calls) !== JSON.stringify(want)) failures.push(`${tag}: clicks reported ${JSON.stringify(calls)}, expected ${JSON.stringify(want)}`)
  const after = await call('state')
  if (after.calls || (await js('window.selectCalls')).length || after.dragging || after.clones) failures.push(`${tag}: clicking the header actions also dragged, dropped or selected (${JSON.stringify(after)})`)
  if (!(await js('window.order()')).blocks.some((x) => x.id === `un:${PENCIL_KEY}`)) failures.push(`${tag}: clicking the header actions collapsed the folder`)

  // A press on the pencil moved 30px down does not lift the folder, and its release does nothing.
  await reset({ mode: 'folders', density, agents })
  await hover(pc.x, pc.y)
  await waitNewStill()
  await press(pc.x, pc.y)
  await moveTo(pc.x, pc.y + 30, 3)
  await frames(2)
  const pressed = await call('state')
  const lifted = await folderDragging(PENCIL_KEY)
  if (pressed.dragging || pressed.clones || lifted) failures.push(`${tag}: a press on the pencil moved 30px started a drag (dragging ${pressed.dragging}, clones ${pressed.clones}, folder .dragging ${lifted})`)
  await release()
  await delay(250)
  const released = await waitClean()
  const stray = { drops: await js('window.dropCalls'), news: await js('window.newCalls'), selects: await js('window.selectCalls') }
  if (!clean(released)) failures.push(`${tag}: the pencil press left drag state behind: ${JSON.stringify(released)}`)
  if (stray.drops.length || stray.news.length || stray.selects.length) failures.push(`${tag}: the release after pressing the pencil and moving away reported ${JSON.stringify(stray)}`)
  info.press = { dragging: pressed.dragging, clones: pressed.clones, lifted }

  // Tooltips. The pencil's leaves the folder and agent open; each logo's names its agent. A row's logo
  // still names its agent, but the row is a scrub host, which the tooltip layer prefers to anything
  // inside it, so the pointer on it shows the row's own label.
  await reset({ mode: 'folders', density, agents, tips: true })
  info.tips = []
  const expectTip = async (what, want) => {
    const tip = await waitTip((t) => t.text === want)
    info.tips.push({ what, text: tip ? tip.text : null })
    if (!tip || tip.text !== want) failures.push(`${tag}: the pointer on ${what} shows the tooltip ${JSON.stringify(tip && tip.text)}, expected ${JSON.stringify(want)}`)
  }
  const pencilGlyph = await call('newGlyph', PENCIL_KEY, 0)
  const pg = middle(pencilGlyph)
  await hover(pg.x, pg.y)
  await expectTip('the pencil', 'New conversation')
  await waitNewStill()
  for (let i = 0; i < agents.length; i++) {
    const c = middle(await call('newGlyph', PENCIL_KEY, i + 1))
    await moveTo(c.x, c.y, 1.5)
    await expectTip(`the ${agents[i]} logo`, `New ${AGENT_LABELS[agents[i]]} conversation`)
  }
  info.tipShot = (await screenshot(`${label()}-pencil-tip-${tag}`)).file
  for (const [key, agent] of TIP_ROWS) {
    const logo = await call('rowLogo', key)
    if (!logo) { failures.push(`harness: ${tag}: row ${key} has no agent logo`); continue }
    if (logo.tip !== AGENT_LABELS[agent] || logo.role !== 'img') failures.push(`${tag}: row ${key}'s logo is labeled ${JSON.stringify(logo.tip)} (role ${logo.role}), expected ${JSON.stringify(AGENT_LABELS[agent])} as an image`)
    if (!logo.scrub) failures.push(`${tag}: row ${key} is not a scrub host`)
    const c = middle(logo.rect)
    await hover(c.x, c.y)
    const tip = await waitTip((t) => (t.title ?? t.text) === logo.rowTip)
    const shownText = tip ? tip.title ?? tip.text : null
    info.tips.push({ what: `row ${key}'s logo`, text: shownText })
    if (shownText !== logo.rowTip) failures.push(`${tag}: the pointer on row ${key}'s logo shows ${JSON.stringify(shownText)}, expected the row's label ${JSON.stringify(logo.rowTip)}`)
  }
  await park()
  return info
}

CHECKS['14-pencil'] = async () => {
  const failures = []
  const details = {}
  // The rail head's new-conversation button: labeled with its shortcut, and one click reports one call.
  await reset({ mode: 'folders' })
  const head = await call('headNew')
  if (!head) failures.push('head: the rail head has no .sb-rail-new-btn')
  else {
    if (head.tip !== HEAD_NEW_TIP) failures.push(`head: the new-conversation button's tooltip is ${JSON.stringify(head.tip)}, expected ${JSON.stringify(HEAD_NEW_TIP)}`)
    const c = middle(head.rect)
    await press(c.x, c.y)
    await release()
    await delay(80)
    const headCalls = await js('window.headNewCalls')
    if (headCalls !== 1) failures.push(`head: one click on the new-conversation button called onNewConversation ${headCalls} times, expected 1`)
    const stray = { drops: await js('window.dropCalls'), news: await js('window.newCalls'), selects: await js('window.selectCalls') }
    if (stray.drops.length || stray.news.length || stray.selects.length) failures.push(`head: the click on the new-conversation button also reported ${JSON.stringify(stray)}`)
    details.head = { tip: head.tip, label: head.label, calls: headCalls }
  }
  for (const density of ['compact', 'spacious']) {
    for (const agents of PENCIL_AGENT_SETS) {
      const info = await pencilCase(density, agents, failures)
      details[info.tag] = info
    }
    // A click on a folder's name collapses it and leaves focus on its toggle. Once the pointer leaves,
    // the pencil hides again: only keyboard focus holds the actions shown, which Tab then does. Nothing
    // selected, since a folder holding the conversation on screen stays open.
    await reset({ mode: 'folders', density, selected: null })
    const named = await waitHeadStill(PENCIL_KEY)
    const nc = { x: named.label.left + Math.min(20, named.label.width / 2), y: named.label.top + named.label.height / 2 }
    await press(nc.x, nc.y)
    await release()
    await park()
    await waitNewStill()
    const collapsed = !(await js('window.order()')).blocks.some((x) => x.id === `un:${PENCIL_KEY}`)
    const toggleFocused = await js(`!!document.activeElement?.matches('section.sb-group[data-key=${JSON.stringify(PENCIL_KEY)}] .sb-group-toggle')`)
    if (!collapsed || !toggleFocused) failures.push(`harness: ${density}: clicking ${PENCIL_KEY}'s name did not collapse it with focus on its toggle (collapsed ${collapsed}, focused ${toggleFocused})`)
    const afterClick = (await call('pencilOpacities')).find((p) => p.key === PENCIL_KEY)
    if (!afterClick || afterClick.opacity > 0.001) failures.push(`${density}: after a click collapsed ${PENCIL_KEY} and the pointer left, its pencil still shows (opacity ${afterClick && afterClick.opacity})`)
    for (const type of ['keyDown', 'keyUp']) {
      await dbg.sendCommand('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    }
    await waitNewStill()
    const afterTab = (await call('pencilOpacities')).find((p) => p.key === PENCIL_KEY)
    if (!afterTab || afterTab.opacity < 0.999) failures.push(`${density}: Tab from ${PENCIL_KEY}'s toggle to its pencil leaves the pencil hidden (opacity ${afterTab && afterTab.opacity})`)
    details[`${density}/focus`] = { afterClick: afterClick && afterClick.opacity, afterTab: afterTab && afterTab.opacity }
    // A folder drag from a header's label: the actions are hidden on every folder and in the clone for
    // its duration, and visible again once it ends.
    await reset({ mode: 'folders', density })
    const g = await folderGrab()
    const hit = await call('hitAt', g.px, g.py)
    if (hit.toggle !== FOLDER_KEY) failures.push(`harness: ${density}: the folder drag press point misses ${FOLDER_KEY}'s label (${JSON.stringify(hit)})`)
    await press(g.px, g.py)
    await moveTo(g.px, g.py + 12, 3)
    await delay(260)
    await frames(2)
    if (!(await call('state')).dragging) { failures.push(`${density}: a folder header drag did not start`); await release(); continue }
    const during = await call('newVisibility')
    const visible = during.rail.filter((v) => v.visibility !== 'hidden')
    if (visible.length) failures.push(`${density}: mid-drag, ${visible.length}/${during.rail.length} folders still show their header actions (${visible.slice(0, 3).map((v) => v.key).join(', ')})`)
    if (during.clone.length !== 1 || during.clone[0] !== 'hidden') failures.push(`${density}: mid-drag, the clone's header actions are ${JSON.stringify(during.clone)}, expected one hidden`)
    await moveTo(g.px, g.py, 3)
    await frames(2)
    await release()
    await delay(450)
    const cleaned = await waitClean()
    const ended = await call('newVisibility')
    const still = ended.rail.filter((v) => v.visibility !== 'visible')
    if (!clean(cleaned)) failures.push(`${density}: the folder drag left state behind: ${JSON.stringify(cleaned)}`)
    if (still.length || ended.clone.length) failures.push(`${density}: after the drag, ${still.length} folders' header actions are not visible (${still.slice(0, 3).map((v) => v.key).join(', ')}), ${ended.clone.length} in a clone`)
    details[`${density}/drag`] = { during: { rail: during.rail.length, visible: visible.length, clone: during.clone }, after: { notVisible: still.length } }
  }
  record('14-pencil', failures, details)
}

// Geometry: the selected row's 2px ring must clear the rail body's overflow clip on every side.
async function ringCase(mode, density, position, failures) {
  await reset({ mode, density })
  const order = await js('window.order()')
  const rows = order.blocks.flatMap((b) => b.rows)
  const key = position === 'top' ? rows[0] : rows[rows.length - 1]
  await configure({ selected: key })
  await call('scrollTo', position === 'top' ? 0 : 1e9)
  await park()
  await settle(300) // the bottom fade transitions out once scrolled to the end
  const g = await call('ring', key)
  if (!g.selected) { failures.push(`${mode}/${density}/${position}: row ${key} not selected`); return }
  if (!/0px 0px 0px 2px/.test(g.shadow)) failures.push(`${mode}/${density}/${position}: unexpected ring ${g.shadow}`)
  const shot = await screenshot(`${label()}-ring-${mode}-${density}-${position}`)
  const s = shot.width / (await js('innerWidth'))
  const { row, clip } = g
  const dom = {
    left: +(row.left - 2 - clip.left).toFixed(2), right: +(clip.right - (row.right + 2)).toFixed(2),
    top: +(row.top - 2 - clip.top).toFixed(2), bottom: +(clip.bottom - (row.bottom + 2)).toFixed(2)
  }
  // A line of device pixels across one edge, from 4 CSS px outside the row to 1.5 inside it. Each pixel
  // is scored as the fraction of ring it carries against the surface on ITS side of the row's (snapped)
  // edge — the rail's paper outside, the white row inside — so a ring the rasterizer snapped a pixel
  // either way still sums to its full width, and a clipped one comes up short.
  const channel = (surface) => [0, 1, 2].reduce((best, c) => (Math.abs(g.ring[c] - surface[c]) > Math.abs(g.ring[best] - surface[best]) ? c : best), 0)
  const score = (c, surface) => { const k = channel(surface); return Math.max(0, Math.min(1, (c[k] - surface[k]) / (g.ring[k] - surface[k]))) }
  const across = (edge, outward, sampleAt) => {
    const e = edge * s, boundary = Math.round(e)
    let w = 0
    for (let p = Math.floor(e - 4 * s); p <= Math.ceil(e + 4 * s); p++) {
      const offset = outward < 0 ? boundary - (p + 1) : p - boundary // >= 0 outside the row
      const depth = outward < 0 ? e - (p + 0.5) : (p + 0.5) - e
      if (depth > 4 * s || depth < -1.5 * s) continue
      w += score(sampleAt(p), offset >= 0 ? g.outside : g.inside)
    }
    return w
  }
  const ys = Math.round((row.top + row.height / 2) * s), xs = Math.round((row.left + Math.min(40, row.width / 4)) * s)
  const pixel = {
    left: across(row.left, -1, (p) => shot.at(p, ys)),
    right: across(row.right, 1, (p) => shot.at(p, ys)),
    top: across(row.top, -1, (p) => shot.at(xs, p)),
    bottom: across(row.bottom, 1, (p) => shot.at(xs, p))
  }
  const expected = 2 * s
  for (const side of ['left', 'right', 'top', 'bottom']) {
    if (dom[side] < 0) failures.push(`${mode}/${density}/${position}: ring overruns the clip on the ${side} by ${(-dom[side]).toFixed(2)}px`)
    if (Math.abs(pixel[side] - expected) > 0.75) failures.push(`${mode}/${density}/${position}: ${side} ring paints ${pixel[side].toFixed(2)} device px, expected ${expected.toFixed(2)}`)
  }
  ringRows.push({ theme: ctx.theme, zoom: ctx.zoom, mode, density, position, key, clearance: dom,
    ringPx: Object.fromEntries(Object.entries(pixel).map(([k, v]) => [k, +v.toFixed(2)])), expectedPx: +expected.toFixed(2), shot: shot.file })
}
CHECKS['9-ring-geometry'] = async () => {
  const failures = []
  for (const mode of ['all', 'folders']) for (const density of ['compact', 'spacious']) for (const position of ['top', 'bottom']) {
    await ringCase(mode, density, position, failures)
  }
  record('9-ring-geometry', failures, {})
}

// The head's one row fits the rail at its minimum width (the host's 300px is PANE_LIMITS.min) in
// Folders mode, where its tools are widest: every tool on one line, inside the head, clear of the
// grouping toggle. The head never wraps, so this is what holds the minimum honest as tools are added.
CHECKS['15-head-fit'] = async () => {
  const failures = []
  await reset({ mode: 'folders' })
  await settle(60)
  const g = await js(`(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top } }
    return {
      row: box(document.querySelector('.sb-rail-head-top')),
      mode: box(document.querySelector('.sb-rail-mode')),
      tools: [...document.querySelectorAll('.sb-rail-head-tools > button')].map(box)
    }
  })()`)
  const first = g.tools[0], last = g.tools[g.tools.length - 1]
  if (g.tools.length < 5) failures.push(`expected the five Folders-mode tools, found ${g.tools.length}`)
  if (g.tools.some((t) => Math.abs(t.top - first.top) > 0.5)) failures.push('the tools do not sit on one line')
  if (last.right > g.row.right + 0.5) failures.push(`the last tool overruns the head by ${(last.right - g.row.right).toFixed(2)}px`)
  const room = first.left - g.mode.right
  if (room < 8) failures.push(`only ${room.toFixed(2)}px between the grouping toggle and the tools`)
  record('15-head-fit', failures, { room: +room.toFixed(2), tools: g.tools.length })
}

// The Escape that closes a rail menu — the filter's or a row's — is that menu's alone. App listens for
// Escape on the window to clear the rail's search or close Find, so an Escape that reached it would
// also throw that away; a bubble-phase window listener stands in for App's here.
CHECKS['16-menu-escape'] = async () => {
  const failures = []
  await reset({ mode: 'folders' })
  await js(`window.appEscapes = 0
    if (!window.appEscapeListener) {
      window.appEscapeListener = (e) => { if (e.key === 'Escape') window.appEscapes++ }
      window.addEventListener('keydown', window.appEscapeListener)
    }`)
  const escapeCloses = async (name, isOpen) => {
    if (!(await js(isOpen))) { failures.push(`${name}: no menu opened`); return }
    const before = await js('window.appEscapes')
    await escapeKey()
    if (await js(isOpen)) failures.push(`${name}: Escape left the menu open`)
    const reached = (await js('window.appEscapes')) - before
    if (reached !== 0) failures.push(`${name}: the Escape that closed the menu reached the window ${reached}x`)
  }

  const btn = await js(`document.querySelector('.sb-rail-filter-btn').getBoundingClientRect().toJSON()`)
  await press(btn.left + btn.width / 2, btn.top + btn.height / 2)
  await release()
  await settle(60)
  await escapeCloses('filter menu', `!!document.querySelector('.sb-filter-menu')`)

  // A row's ⋮ menu fades out on close, so "closed" is its closing class as much as its absence.
  const key = (await js('window.order()')).blocks[0].rows[0]
  const row = await call('rowRect', key)
  await hover(row.left + 60, row.top + row.height / 2)
  await delay(60)
  const menu = await call('menuButton', key)
  if (!menu) failures.push(`row menu: no ⋮ button on ${key}`)
  else {
    await press(menu.rect.left + menu.rect.width / 2, menu.rect.top + menu.rect.height / 2)
    await release()
    await settle(60)
    await escapeCloses('row menu', `!!document.querySelector('.sb-ctxmenu:not(.sb-filter-menu):not(.closing)')`)
  }
  await park()
  record('16-menu-escape', failures, {})
}

// No drag while a filter is set, as while searching: the neighbors a drop reports would straddle rows
// the filter leaves out. The same press-and-move drags with no filter, so a broken gesture cannot pass.
CHECKS['17-filter-no-drag'] = async () => {
  const failures = []
  const attempt = async (filter) => {
    await reset({ mode: 'folders', filter })
    const key = (await js('window.order()')).blocks.find((b) => b.rows.length > 0).rows[0]
    const r = await call('rowRect', key)
    const x = r.left + 60, y = r.top + r.height / 2
    await press(x, y)
    await moveTo(x, y + 60, 6)
    const s = await call('state')
    await release()
    await delay(200)
    return { key, dragging: s.dragging || s.clones > 0, drops: (await js('window.dropCalls')).length }
  }
  const free = await attempt([])
  if (!free.dragging) failures.push(`harness: with no filter, press-and-move on ${free.key} did not drag`)
  // Live leaves the fixture's running rows; any set criterion locks drags the same way.
  const live = await attempt(['live'])
  if (live.dragging) failures.push(`Live: press-and-move on ${live.key} started a drag`)
  if (live.drops) failures.push(`Live: the gesture produced ${live.drops} drop calls`)
  await park()
  record('17-filter-no-drag', failures, { free })
}

function summary(r) {
  return { key: r.key, landing: r.expect.index, gap: r.gap?.index, call: r.calls?.[0] ?? null, shot: r.shot }
}

async function runCheck(name) {
  const number = name.split('-')[0]
  if (ONLY.size && !ONLY.has(number) && !ONLY.has(name) && !ONLY.has(name.slice(number.length + 1))) return
  ctx.check = name
  try {
    await CHECKS[name]()
  } catch (error) {
    record(name, [`${error.message}`], { stack: error.stack })
  } finally {
    await park().catch(() => {})
  }
}

app.whenReady().then(async () => {
  const started = Date.now()
  const deadline = setTimeout(() => { console.error('Rail renderer check timed out'); app.exit(1) }, 600000)
  let fatal = null
  try {
    win = new BrowserWindow({ width: 380, height: 680, show: false, webPreferences: { backgroundThrottling: false } })
    await win.loadFile(join(output, 'dist/index.html'))
    dbg = win.webContents.debugger
    dbg.attach('1.3')
    await js(`(${installRailHelpers.toString()})()`)
    // Mutation self-test for the ring check: RAIL_MUTATE=clip removes the room the ring paints in, which
    // the geometry check must then report on the top and trailing sides.
    if (process.env.RAIL_MUTATE === 'clip') {
      await js(`document.head.insertAdjacentHTML('beforeend', '<style>.sb-rail-body { padding-top: 1px !important; padding-right: 1px !important; }</style>')`)
    }
    await settle(100)
    const booted = await js("({ rail: !!document.querySelector('.sb-rail-body'), errors: window.auditErrors })")
    if (!booted.rail) throw new Error('fixture did not render the rail: ' + JSON.stringify(booted.errors))
    for (const theme of THEMES) {
      ctx = { theme }
      for (const zoom of GEOMETRY_ZOOMS) {
        ctx.zoom = zoom
        win.webContents.setZoomLevel(zoom)
        await settle(150)
        await calibrate()
        if (DRAG_ZOOMS.includes(zoom)) {
          for (const name of Object.keys(CHECKS)) if (name !== '9-ring-geometry') await runCheck(name)
        }
        await runCheck('9-ring-geometry')
      }
    }
  } catch (error) {
    fatal = error
    console.error(error.stack)
  } finally {
    clearTimeout(deadline)
    const failed = results.filter((r) => !r.pass)
    const summaryOut = {
      runtimeSeconds: +((Date.now() - started) / 1000).toFixed(1),
      passed: results.length - failed.length, failed: failed.length, fatal: fatal ? fatal.message : null,
      results: results.map(({ check, theme, zoom, pass, failures }) => ({ check, theme, zoom, pass, failures })),
      ring: ringRows.map(({ theme, zoom, mode, density, position, clearance, ringPx, expectedPx }) => ({ theme, zoom, mode, density, position, clearance, ringPx, expectedPx })),
      harnessNotes
    }
    writeFileSync(join(output, 'results.json'), JSON.stringify({ ...summaryOut, details: results, ring: ringRows }, null, 2))
    console.log(JSON.stringify(summaryOut, null, 2))
    if (failed.length || fatal) console.error(`Rail renderer failures: ${failed.length}${fatal ? ' (fatal: ' + fatal.message + ')' : ''}`)
    else console.log('PASS rail drag, cancel, autoscroll, wheel and ring geometry across both themes and zoom steps')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(failed.length || fatal ? 1 : 0)
  }
})
