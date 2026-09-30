// Launch a made-up Switchboard for the README screenshots and arrange it, then leave it running for
// the capture. The app runs against a fake home (fixture.cjs) with a fresh profile, so it sees none
// of the machine's own conversations, and its terminals can only reach the stand-in agents. Quit the
// window (or Ctrl-C) when done; the temporary home is removed on exit.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const { buildFixture } = require('./fixture.cjs')

const ROOT = path.resolve(__dirname, '..', '..')
const PORT = Number(process.env.SCREENSHOT_CDP_PORT || 9400)
// Where the made-up projects live: the pane header shows this path, and it must be a real, writable
// directory. Claimed with a marker file so a directory that is not ours is never touched.
const PROJECTS = '/Users/Shared/demo'
const MARKER = '.switchboard-readme-screenshots'
// The window size for the README screenshots, in points.
const WINDOW = { width: 1728, height: 1084 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 150; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          ws.addEventListener('open', resolve, { once: true })
          ws.addEventListener('error', reject, { once: true })
        })
        return ws
      }
    } catch {
      /* not listening yet */
    }
    await sleep(200)
  }
  throw new Error('the app did not open a debuggable window')
}

function cdpClient(ws) {
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const waitFor = async (expression, what, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (await ev(expression)) return
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  return { send, ev, waitFor }
}

async function arrange({ send, ev, waitFor }, fx) {
  const row = (id) => `document.querySelector('.sb-rail-body .sb-row[data-session="${id}"]')`
  const count = fx.shownRows
  const rowsReady = `document.querySelectorAll('.sb-rail-body .sb-row[data-session]').length >= ${count}`
  const dismissWhatsNew = `document.querySelector('.sb-whatsnew-done')?.click()`

  // Settings first, then a reload to apply them — rows are only counted once the pins are in, since a
  // pinned row does not count toward its folder's cap. What's new has had its turn; start in light.
  await waitFor(`!!document.querySelector('.sb-titlebar')`, 'the window')
  await ev(`(() => {
    localStorage.setItem('switchboard.once', JSON.stringify(['whatsNew:1']))
    localStorage.setItem('switchboard.pinnedOrder', ${JSON.stringify(JSON.stringify(fx.pinned))})
    localStorage.setItem('switchboard.theme', 'light')
    window.__beforeReload = true
  })()`)
  await send('Page.reload')
  try {
    await waitFor(`!window.__beforeReload && ${rowsReady}`, 'the conversations to load')
  } catch (e) {
    const shown = await ev(`[...document.querySelectorAll('.sb-rail-body .sb-row[data-session]')].map((r) => r.dataset.session)`)
    const missing = Object.entries(fx.ids).filter(([, id]) => !shown.includes(id)).map(([k]) => k)
    throw new Error(`${e.message}: ${shown.length} of ${count} rows, missing ${missing.join(', ')}`)
  }
  await ev(dismissWhatsNew)

  // Three live conversations, each kept in its own tab: resumed on the stand-in agent.
  for (const key of ['debounce', 'forecast', 'tileCache']) {
    const id = fx.ids[key]
    await ev(`(() => { const r = ${row(id)}; r.click(); r.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`)
    await waitFor(`!!document.querySelector('.sb-tab[data-session-id="${id}"]')`, `the ${key} tab`)
    await waitFor(`!!document.querySelector('[aria-label="Resume session"]')`, `Resume on ${key}`)
    await ev(`document.querySelector('[aria-label="Resume session"]').click()`)
    await waitFor(`${row(id)}?.classList.contains('live')`, `${key} to go live`)
  }
  // One preview tab, then back to the conversation shown in the pane, in the Formatted view.
  await ev(`${row(fx.ids.geocoder)}.click()`)
  await waitFor(`!!document.querySelector('.sb-tab.preview[data-session-id="${fx.ids.geocoder}"]')`, 'the preview tab')
  await ev(`document.querySelector('.sb-tab[data-session-id="${fx.ids.tileCache}"]').click()`)
  await sleep(300)
  await ev(`[...document.querySelectorAll('.sb-pane-header .sb-seg button')].find((b) => b.textContent.includes('Formatted'))?.click()`)
  await sleep(300)
  // Resuming read them; ⌥-click marks two finished turns unread again.
  for (const key of ['debounce', 'forecast']) {
    await ev(`${row(fx.ids[key])}.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`)
  }
  await ev(`document.activeElement?.blur()`)
  await ev(dismissWhatsNew)
  // The shown conversation must fit: a scrolled transcript shows a jump-to-edge pill.
  const overflow = await ev(`(() => { const s = [...document.querySelectorAll('.transcript-scroll')].find((e) => e.clientHeight > 0); return s ? s.scrollHeight - s.clientHeight : null })()`)
  if (overflow == null || overflow > 1) throw new Error(`the shown conversation does not fit the pane (overflow: ${overflow}px)`)
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    throw new Error('no build found: run `npm run build` first')
  }
  // A leftover from an earlier run carries the marker and is replaced; anything else is left alone.
  if (fs.existsSync(PROJECTS) && !fs.existsSync(path.join(PROJECTS, MARKER))) {
    throw new Error(`${PROJECTS} already exists and was not made by this script; move it aside first`)
  }
  fs.rmSync(PROJECTS, { recursive: true, force: true })
  fs.mkdirSync(PROJECTS, { recursive: true })
  fs.writeFileSync(path.join(PROJECTS, MARKER), '')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-readme-'))
  const home = path.join(temp, 'home')
  const profile = path.join(temp, 'profile')
  fs.mkdirSync(profile, { recursive: true })
  fs.writeFileSync(path.join(profile, 'window-state.json'), JSON.stringify(WINDOW))
  const fx = buildFixture(home, PROJECTS)

  const electron = createRequire(path.join(ROOT, 'package.json'))('electron')
  // A deliberately small environment: nothing from the caller's shell (its PATH included) reaches
  // the app or its terminals.
  const env = {
    HOME: home,
    USER: 'demo',
    LOGNAME: 'demo',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    TMPDIR: os.tmpdir(),
    PATH: `${fx.bin}:/usr/bin:/bin:/usr/sbin:/sbin`
  }
  // --use-mock-keychain: Chromium keeps its storage key in the login keychain, which macOS finds
  // through HOME; the made-up home has none, so without this every launch asks where to create one.
  const args = [ROOT, `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--use-mock-keychain']
  const app = spawn(electron, args, { env, stdio: 'ignore' })
  const cleanup = () => {
    fs.rmSync(temp, { recursive: true, force: true })
    fs.rmSync(PROJECTS, { recursive: true, force: true })
  }
  process.on('SIGINT', () => app.kill())
  process.on('SIGTERM', () => app.kill())
  app.on('exit', () => {
    cleanup()
    process.exit()
  })

  try {
    const ws = await connect()
    await arrange(cdpClient(ws), fx)
    ws.close()
  } catch (e) {
    process.exitCode = 1
    app.kill()
    throw e
  }
  console.log('Ready. Switch themes with the title bar’s sun/moon button; avoid clicking rows or tabs, which')
  console.log(`would mark them read. Quit the window or press Ctrl-C to stop; the made-up home and ${PROJECTS} are then removed.`)
}

main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
