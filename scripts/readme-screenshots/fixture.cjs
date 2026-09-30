// A made-up home for the README screenshots: conversations for both agents in their own on-disk
// formats, stand-in `claude` / `codex` commands, and the shell setup that makes those stand-ins the
// only agents a terminal in this home can run. Nothing here is real, and nothing reaches a network.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const MIN = 60_000

// Project folders, relative to the projects root. The pane header shows a conversation's folder
// verbatim, and a resumed terminal starts in it, so these are real directories.
const FOLDERS = {
  weather: 'code/weather-station',
  atlas: 'code/atlas',
  field: 'code/field-notes',
  portfolio: 'code/portfolio-site',
  notes: 'notes',
  dotfiles: 'code/dotfiles'
}

const TILE_CACHE_ANSWER = `## How the tile cache decides

The cache in \`src/tiles/cache.ts\` is a **least-recently-used** map keyed by \`z/x/y\`:

- A hit moves the tile to the front, so tiles you keep looking at stay.
- A miss fetches the tile, inserts it at the front, and evicts from the back.
- The bound is **256 tiles** — a count, not a size.

### Why panning back misses

Every pan also prefetches a ring of tiles around the viewport, about 40 at a time. Two or three quick
pans push the tiles you just left off the back of the list, so returning to them fetches them again.

\`\`\`ts
const cache = new LruCache<TileKey, Tile>({ max: 256 })
\`\`\`

Sizing the cache by bytes, and keeping the visible tiles out of eviction, would fix both. Want me to
make that change?`

const TILE_CACHE_DONE = `Done. The cache is now bounded at **64 MB**, never evicts a tile that is on screen, and caps the
prefetch ring at 24 tiles. All 48 tests in \`tiles/\` pass, including two new ones.`

/**
 * Every conversation, newest last activity first. `ago` is minutes since its last activity; `live`
 * marks the ones the launcher resumes. A folder shows five rows, its pins among them; `beyondCap`
 * marks the one row that is deliberately past that, behind its folder's Show more.
 */
const CONVERSATIONS = [
  {
    key: 'tileCache', agent: 'claude', folder: 'atlas', ago: 1, live: true,
    title: 'Explain the tile cache',
    turns: [
      {
        user: 'How does the tile cache decide what to evict? Panning back seems to re-download tiles we just saw.',
        tools: [
          { name: 'Read', input: { file_path: 'src/tiles/cache.ts' }, output: 'export class TileCache { … }' },
          { name: 'Grep', input: { pattern: 'prefetch', path: 'src/tiles' }, output: 'src/tiles/prefetch.ts:12' }
        ],
        reply: TILE_CACHE_ANSWER
      },
      {
        user: 'Yes, size it by bytes. 64 MB is plenty.',
        tools: [
          { name: 'Edit', input: { file_path: 'src/tiles/cache.ts' }, output: 'Updated src/tiles/cache.ts' },
          { name: 'Edit', input: { file_path: 'src/tiles/prefetch.ts' }, output: 'Updated src/tiles/prefetch.ts' },
          { name: 'Bash', input: { command: 'npm test -- tiles' }, output: 'Tests  48 passed (48)' }
        ],
        reply: TILE_CACHE_DONE
      }
    ]
  },
  {
    key: 'debounce', agent: 'claude', folder: 'weather', ago: 3, live: true,
    title: 'Debounce the rain gauge',
    turns: [
      {
        user: 'The rain gauge double-counts when the bucket bounces. Can you debounce it?',
        tools: [{ name: 'Read', input: { file_path: 'firmware/rain.c' }, output: 'void on_tip(void) { … }' }],
        reply: 'A second tip within 200 ms now counts as a bounce, which still allows five tips a second in a heavy downpour.'
      }
    ]
  },
  {
    key: 'forecast', agent: 'claude', folder: 'weather', ago: 6, live: true,
    title: 'Add a 7-day forecast chart',
    turns: [
      {
        user: 'Add a 7-day forecast chart under the current conditions card.',
        tools: [
          { name: 'Read', input: { file_path: 'web/src/Dashboard.tsx' }, output: 'export function Dashboard() { … }' },
          { name: 'Write', input: { file_path: 'web/src/ForecastChart.tsx' }, output: 'Created web/src/ForecastChart.tsx' }
        ],
        reply: 'Added `ForecastChart` below the conditions card: daily highs and lows as a band, with precipitation chance as bars underneath.'
      }
    ]
  },
  {
    key: 'release', agent: 'claude', folder: 'atlas', ago: 25, pinned: true,
    title: 'Release checklist',
    turns: [{ user: 'Draft a release checklist for the 2.0 map release.', reply: 'Here is a checklist covering tiles, search, offline packs, and the changelog.' }]
  },
  {
    key: 'celsius', agent: 'codex', folder: 'weather', ago: 38,
    title: 'Fix the Celsius rounding',
    turns: [{ user: 'Temperatures show 21.999 instead of 22.0 on the dashboard. Can you fix the rounding?', reply: 'Rounded at display time with one decimal; the stored readings keep full precision.' }]
  },
  {
    key: 'geocoder', agent: 'claude', folder: 'atlas', ago: 52,
    title: 'Write tests for the geocoder',
    turns: [{ user: 'Write tests for the geocoder, including addresses with unit numbers.', reply: 'Added 14 cases covering unit numbers, PO boxes, and ambiguous street names.' }]
  },
  {
    key: 'settings', agent: 'claude', folder: 'weather', ago: 75, pinned: true,
    title: 'Refactor the settings screen',
    turns: [{ user: 'Split the settings screen into sections: units, alerts, and sensors.', reply: 'Split into three sections, each with its own save state.' }]
  },
  {
    key: 'vector', agent: 'codex', folder: 'atlas', ago: 140,
    title: 'Migrate to vector tiles',
    turns: [{ user: 'What would it take to move the map from raster to vector tiles?', reply: 'Three pieces: a style file, a new tile source, and replacing the label layer.' }]
  },
  {
    key: 'albatross', agent: 'claude', folder: 'field', ago: 190,
    title: 'How albatrosses glide so far',
    turns: [{ user: 'How do albatrosses fly so far without flapping?', reply: 'Dynamic soaring: they harvest the difference in wind speed between the wave tops and the air above.' }]
  },
  {
    key: 'tides', agent: 'codex', folder: 'field', ago: 260,
    title: 'Summarize the tide tables',
    turns: [{ user: 'Summarize this month of tide tables into the best low tides for tide-pooling.', reply: 'Five mornings stand out, all below −0.5 ft before 9 a.m.' }]
  },
  {
    key: 'lightning', agent: 'claude', folder: 'notes', ago: 400,
    title: 'What creates lightning',
    turns: [{ user: 'What creates lightning?', reply: 'Charge separates inside a storm cloud until the air breaks down and a channel connects.' }]
  },
  {
    key: 'sourdough', agent: 'claude', folder: 'notes', ago: 1500,
    title: 'How sourdough starters work',
    turns: [{ user: 'How does a sourdough starter actually work?', reply: 'Wild yeast and lactic acid bacteria share the flour: the yeast raises it, the bacteria sour it.' }]
  },
  {
    key: 'kyoto', agent: 'codex', folder: 'notes', ago: 2900,
    title: 'Plan a weekend in Kyoto',
    turns: [{ user: 'Plan a relaxed weekend in Kyoto in early spring.', reply: 'Two days: the eastern temples on foot, then Arashiyama early before the crowds.' }]
  },
  {
    key: 'search', agent: 'claude', folder: 'atlas', ago: 95,
    title: 'Speed up search suggestions',
    turns: [{ user: 'Search suggestions lag behind typing. Can you speed them up?', reply: 'Suggestions now debounce at 120 ms and reuse the last result while the next is in flight.' }]
  },
  {
    key: 'rss', agent: 'codex', folder: 'portfolio', ago: 320,
    title: 'Add an RSS feed',
    turns: [{ user: 'Add an RSS feed for the blog posts.', reply: 'Added /feed.xml with the latest twenty posts, linked from every page’s head.' }]
  },
  {
    key: 'battery', agent: 'claude', folder: 'weather', ago: 160,
    title: 'Battery saver for the sensor',
    turns: [{ user: 'Add a battery saver mode that samples less often below 20%.', reply: 'Below 20% the sensor samples every five minutes instead of every minute, and says so on the dashboard.' }]
  },
  // weather-station's sixth, one past the cap, so that folder has its Show more line.
  {
    key: 'frost', agent: 'claude', folder: 'weather', ago: 900, beyondCap: true,
    title: 'Alert when frost is likely',
    turns: [{ user: 'Send an alert when frost is likely overnight.', reply: 'The alert fires when the forecast low is under 2 °C and the sky is clear.' }]
  },
  {
    key: 'export', agent: 'claude', folder: 'field', ago: 2200,
    title: 'Export notes as a PDF',
    turns: [{ user: 'Export a season of field notes as a printable PDF.', reply: 'One entry per page, with its photo, place and moon phase in the margin.' }]
  },
  {
    key: 'sync', agent: 'claude', folder: 'dotfiles', ago: 610,
    title: 'Sync settings across machines',
    turns: [{ user: 'How should I keep these dotfiles in sync across two laptops?', reply: 'A bare git repo in the home folder, with a small bootstrap script for a new machine.' }]
  },
  {
    key: 'birdcall', agent: 'claude', folder: 'field', ago: 480,
    title: 'Tag entries by location',
    turns: [{ user: 'Tag each field note with the place it was written.', reply: 'Each entry now stores a place name, with the coordinates kept alongside for the map view.' }]
  },
  {
    key: 'moon', agent: 'codex', folder: 'field', ago: 1300,
    title: 'Moon phase on each entry',
    turns: [{ user: 'Show the moon phase next to each entry’s date.', reply: 'Added a small phase glyph computed from the entry date; no network needed.' }]
  },
  {
    key: 'ebikes', agent: 'claude', folder: 'notes', ago: 3600,
    title: 'Compare two e-bikes',
    turns: [{ user: 'Compare these two e-bikes for a hilly commute.', reply: 'The mid-drive one climbs better; the hub-drive one is cheaper and quieter on the flat.' }]
  },
  {
    key: 'plants', agent: 'codex', folder: 'notes', ago: 4400,
    title: 'Houseplant watering schedule',
    turns: [{ user: 'Make a watering schedule for my houseplants.', reply: 'A weekly table grouped by how dry each plant likes its soil between waterings.' }]
  },
  {
    key: 'darkmode', agent: 'claude', folder: 'portfolio', ago: 720,
    title: 'Dark mode for the blog',
    turns: [{ user: 'Add a dark mode to the blog that follows the system setting.', reply: 'The blog now follows the system theme, with a toggle in the footer to override it.' }]
  },
  {
    key: 'lazyload', agent: 'codex', folder: 'portfolio', ago: 1900,
    title: 'Fix image lazy-loading',
    turns: [{ user: 'Images below the fold never load on Safari. Can you fix it?', reply: 'The loader now falls back to loading images eagerly where lazy loading is unsupported.' }]
  },
  {
    key: 'about', agent: 'claude', folder: 'portfolio', ago: 5200,
    title: 'Write the About page',
    turns: [{ user: 'Draft a short About page from my notes.', reply: 'Here is a three-paragraph draft in your voice, with the talks listed at the end.' }]
  },
  {
    key: 'zsh', agent: 'claude', folder: 'dotfiles', ago: 6100,
    title: 'Speed up shell startup',
    turns: [{ user: 'My shell takes two seconds to start. What is slow?', reply: 'Most of it is the version manager’s init; loading it lazily brings startup under 200 ms.' }]
  },
  {
    key: 'gitaliases', agent: 'codex', folder: 'dotfiles', ago: 7300,
    title: 'Tidy up git aliases',
    turns: [{ user: 'Clean up my git aliases and drop the ones I never use.', reply: 'Kept eleven, removed nine, and grouped the rest by what they do.' }]
  }
]

const iso = (ms) => new Date(ms).toISOString()

/** Claude Code's transcript: one JSON line per event, chained by uuid. */
function claudeLines(conv, cwd, endAt) {
  const lines = []
  let parent = null
  // Spread the turns backwards from the last activity: a line every few seconds, a turn a minute apart.
  let t = endAt - conv.turns.length * MIN
  const push = (obj) => {
    const uuid = randomUUID()
    lines.push({ ...obj, uuid, parentUuid: parent, isSidechain: false, timestamp: iso(t), cwd, gitBranch: 'main', version: '2.1.217' })
    parent = uuid
    t += 4000
  }
  lines.push({ type: 'custom-title', customTitle: conv.title, sessionId: conv.id })
  conv.turns.forEach((turn, i) => {
    t = endAt - (conv.turns.length - i) * MIN
    push({ type: 'user', message: { role: 'user', content: turn.user } })
    for (const tool of turn.tools ?? []) {
      const id = `toolu_${randomUUID().slice(0, 8)}`
      push({ type: 'assistant', message: { role: 'assistant', id: `msg_${id}`, stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: tool.name, input: tool.input }] } })
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: tool.output }] } })
    }
    if (turn.reply) {
      t = endAt - (conv.turns.length - i - 1) * MIN
      push({ type: 'assistant', message: { role: 'assistant', id: `msg_${randomUUID().slice(0, 8)}`, stop_reason: 'end_turn', content: [{ type: 'text', text: turn.reply }] } })
    }
  })
  return lines
}

/** Codex's rollout: session metadata, then task lifecycle events around each turn. */
function codexLines(conv, cwd, endAt) {
  const lines = [{ timestamp: iso(endAt - conv.turns.length * MIN), type: 'session_meta', payload: { session_id: conv.id, id: conv.id, cwd, originator: 'codex-tui', cli_version: '0.142.0' } }]
  conv.turns.forEach((turn, i) => {
    const start = endAt - (conv.turns.length - i) * MIN
    const end = endAt - (conv.turns.length - i - 1) * MIN
    const turnId = `t${i + 1}`
    lines.push(
      { timestamp: iso(start), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
      { timestamp: iso(start), type: 'turn_context', payload: { turn_id: turnId, cwd, model: 'gpt-5.5' } },
      { timestamp: iso(start), type: 'event_msg', payload: { type: 'user_message', message: turn.user } },
      { timestamp: iso(start), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.user }] } },
      { timestamp: iso(end), type: 'response_item', payload: { type: 'message', role: 'assistant', id: `m${i + 1}`, content: [{ type: 'output_text', text: turn.reply }] } },
      { timestamp: iso(end), type: 'event_msg', payload: { type: 'agent_message', message: turn.reply } },
      { timestamp: iso(end), type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: turn.reply } }
    )
  })
  return lines
}

const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

function writeStandIns(home) {
  const bin = path.join(home, '.local', 'stand-ins')
  fs.mkdirSync(bin, { recursive: true })
  for (const name of ['claude', 'codex']) {
    const file = path.join(bin, name)
    fs.writeFileSync(
      file,
      `#!/bin/sh\n# Stand-in ${name} for the README screenshots: holds the terminal open and does nothing else.\n` +
        `printf 'Stand-in ${name} for screenshots. Nothing runs here.\\n'\nwhile :; do sleep 3600; done\n`
    )
    fs.chmodSync(file, 0o755)
  }
  // Functions outrank anything on PATH, so even a PATH rebuilt by the system's login files cannot
  // reach a real agent; the PATH entry is for the app's own `command -v` probe.
  const rc =
    `export PATH="${bin}:$PATH"\n` +
    `claude() { "${bin}/claude" "$@"; }\n` +
    `codex() { "${bin}/codex" "$@"; }\n` +
    `PROMPT='%~ %# '\n`
  fs.writeFileSync(path.join(home, '.zprofile'), rc)
  fs.writeFileSync(path.join(home, '.zshrc'), rc)
  return bin
}

/**
 * Write the fixture into `home` (created if needed), its project folders under `projects`, with
 * activity times relative to `now`. Returns the stand-in bin directory, the pinned ids, how many rows
 * the rail shows, and each conversation's id keyed as in CONVERSATIONS.
 */
function buildFixture(home, projects, now = Date.now()) {
  const bin = writeStandIns(home)
  const ids = {}
  const codexIndex = []
  for (const conv of CONVERSATIONS) {
    conv.id = randomUUID()
    ids[conv.key] = conv.id
    const cwd = path.join(projects, FOLDERS[conv.folder])
    fs.mkdirSync(cwd, { recursive: true })
    const endAt = now - conv.ago * MIN
    let file
    if (conv.agent === 'claude') {
      const dir = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'))
      fs.mkdirSync(dir, { recursive: true })
      file = path.join(dir, `${conv.id}.jsonl`)
      fs.writeFileSync(file, jsonl(claudeLines(conv, cwd, endAt)))
    } else {
      const day = new Date(endAt)
      const dir = path.join(home, '.codex', 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'))
      fs.mkdirSync(dir, { recursive: true })
      file = path.join(dir, `rollout-${iso(endAt).slice(0, 19).replace(/:/g, '-')}-${conv.id}.jsonl`)
      fs.writeFileSync(file, jsonl(codexLines(conv, cwd, endAt)))
      codexIndex.push({ id: conv.id, thread_name: conv.title, updated_at: iso(endAt) })
    }
    fs.utimesSync(file, new Date(endAt), new Date(endAt))
  }
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), jsonl(codexIndex))
  const pinned = CONVERSATIONS.filter((c) => c.pinned).map((c) => c.id)
  const shownRows = CONVERSATIONS.filter((c) => !c.beyondCap).length
  return { bin, ids, pinned, shownRows }
}

module.exports = { buildFixture }
