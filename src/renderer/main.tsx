import { createRoot } from 'react-dom/client'

// Fonts (bundled locally — no CDN, this is a desktop app). Single family:
// Hanken Grotesk across UI + display (heavy weights carry the display moments).
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/hanken-grotesk/700.css'
import '@fontsource/hanken-grotesk/800.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'

import '@xterm/xterm/css/xterm.css'

import './styles/tokens.css'
import './styles/global.css'
import './styles/app.css'
import './styles/sidebar.css'
import './styles/pane.css'
import './styles/transcript.css'
import './styles/rail.css'
import './styles/terminal.css'

import App from './App'
import { resolveTheme } from './lib/theme'
import { applyTheme, readThemeMode, systemPrefersDark } from './lib/themeDom'

// Resolve + apply the persisted theme to <html data-theme> BEFORE first render. The window is
// hidden until ready-to-show (first paint), so applying it here means the first painted frame is
// already in the right theme — no light flash on a dark-mode launch. useTheme re-applies on later
// mode / OS changes. (An inline <head> script would be marginally earlier, but the CSP blocks one.)
applyTheme(resolveTheme(readThemeMode(), systemPrefersDark()))

// Warm the bundled font faces before first paint. @fontsource ships each weight
// separately with `font-display: swap`; a bold run can paint in a fallback face
// and then not repaint when the real face loads (Chromium leaves painted glyphs
// stale until a reflow — selecting/zooming forces it). Decoding up front closes
// that window. Local files (~110 KB), so it's a few ms; the timeout is a ceiling.
const FONT_FACES = [
  '400 1em "Hanken Grotesk"',
  '500 1em "Hanken Grotesk"',
  '600 1em "Hanken Grotesk"',
  '700 1em "Hanken Grotesk"',
  '800 1em "Hanken Grotesk"',
  '400 1em "IBM Plex Mono"',
  '500 1em "IBM Plex Mono"',
  '600 1em "IBM Plex Mono"'
]

const root = createRoot(document.getElementById('root')!)

async function warmFontsThenRender() {
  await Promise.race([
    Promise.all(FONT_FACES.map((face) => document.fonts.load(face))).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 1500))
  ])
  root.render(<App />)
}

warmFontsThenRender()
