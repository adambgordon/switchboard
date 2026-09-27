import React, { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import Sidebar from '@renderer/components/Sidebar'
import TooltipLayer from '@renderer/components/TooltipLayer'
import { buildSidebar, folderRankSpace, rankSpace } from '@renderer/lib/sidebarModel'
import { dropWrites } from '@renderer/lib/rowRank'
import { moveBetween } from '@renderer/lib/reorder'
import '@fontsource/hanken-grotesk/400.css'
import '@fontsource/hanken-grotesk/500.css'
import '@fontsource/hanken-grotesk/600.css'
import '@fontsource/hanken-grotesk/700.css'
import '@fontsource/hanken-grotesk/800.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import '@renderer/styles/tokens.css'
import '@renderer/styles/global.css'
import '@renderer/styles/app.css'
import '@renderer/styles/sidebar.css'
import '@renderer/styles/rail.css'

// The real rail — Sidebar fed by buildSidebar — over sample conversations, with the drop callbacks
// App wires up, so a drag commits through the same rank and pin arithmetic the app uses.

window.auditErrors = []
window.addEventListener('error', (event) => window.auditErrors.push(event.message))
window.addEventListener('unhandledrejection', (event) => window.auditErrors.push(String(event.reason)))
window.api = new Proxy({}, { get: () => () => undefined })
window.dropCalls = []
window.selectCalls = []
// A folder header's new-conversation actions: the pencil (onNewInFolder) and each agent logo (onStartInFolder).
window.newCalls = []
// How many times the rail head's new-conversation button called onNewConversation.
window.headNewCalls = 0
// The last pointer event the page saw, so the runner can tell a dropped synthetic event from a real one
// and calibrate its coordinate space against the page's at each zoom step.
window.lastPointer = null
window.pointerDowns = 0
for (const type of ['pointermove', 'pointerdown', 'pointerup']) {
  document.addEventListener(type, (e) => {
    if (type === 'pointerdown') window.pointerDowns++
    const target = e.target instanceof Element ? e.target.closest('[data-key]') : null
    window.lastPointer = { type, x: e.clientX, y: e.clientY, buttons: e.buttons, key: target?.dataset.key ?? null }
  }, true)
}

const T = Date.UTC(2026, 0, 15, 12)
const HOUR = 3600_000
const FOLDERS = [
  { root: '/home/dev/projects/atlas', count: 25 },
  { root: '/home/dev/projects/beacon', count: 7 },
  { root: '/home/dev/projects/cinder', count: 4 },
  { root: '/home/dev/projects/delta', count: 5 },
  { root: '/home/dev/notes', count: 3 },
  // Small folders, so the rail still overflows with every folder collapsed to its header — a folder drag
  // collapses the rail, and holding the grabbed header in place needs room to scroll. The last name is
  // long enough to truncate in the rail's width.
  ...['echo', 'fjord', 'grove', 'harbor', 'iris', 'juniper', 'kestrel', 'lumen', 'meadow', 'nimbus', 'orbit',
    'prism-shared-component-library-migration-notes']
    .map((name, i) => ({ root: `/home/dev/projects/${name}`, count: 1 + (i % 2) }))
]
const TITLES = [
  'Refactor the indexer walk', 'Fix the flaky resize check', 'Review the migration plan', 'Tighten the cache eviction',
  'Why does the preview go blank?', 'Rename support for both agents', 'Contrast pass on the dark theme',
  'Worktree folding edge cases', 'Settle the tooltip placement', 'Plan the welcome dialog', 'Profile first paint',
  'Parse the rollout index', 'Split view keyboard focus', 'Trim the release notes'
]
const initialPins = () => ['atlas-2', 'atlas-7', 'atlas-11', 'beacon-4', 'beacon-1']
// Folder order pinned by overrides, the way a profile's first run freezes it, so the tall folder is first.
const initialFolderRanks = () => Object.fromEntries(FOLDERS.map((f, i) => [f.root, T - i * 1000 * HOUR]))
const LIVE = { 'atlas-0': 'working', 'atlas-4': 'asking', 'beacon-2': 'awaiting', 'cinder-1': 'quiet' }

function catalog() {
  const groups = FOLDERS.map((f, fi) => {
    const name = f.root.split('/').pop()
    const conversations = Array.from({ length: f.count }, (_, c) => {
      // Interleaved across folders, so a row rank in one folder lands among other folders' rows in All.
      const seed = T - (c * FOLDERS.length + fi) * HOUR
      return {
        sessionId: `${name}-${c}`, agent: (c + fi) % 3 === 0 ? 'codex' : 'claude', cwd: f.root,
        title: `${name} ${c} · ${TITLES[(c + fi * 3) % TITLES.length]}`,
        preview: 'The drag clone copies the row padding, so rows lift without their content shifting sideways',
        gitBranch: null, mtime: seed + HOUR / 2, lastActivityAt: seed + HOUR / 2, messageCount: 4 + c, version: null,
        sizeBytes: 0, model: null, outputTokens: 0, inputTokens: 0, contextTokens: 0, firstActivityAt: seed
      }
    })
    return { cwd: f.root, root: f.root, worktree: false, exists: true, rootExists: true, label: name, conversations, latestMtime: 0 }
  })
  const ptys = Object.keys(LIVE).map((id, i) => {
    const root = groups.find((g) => g.conversations.some((c) => c.sessionId === id)).root
    return {
      ptyId: `p${i}`, sessionId: id, agent: 'claude', cwd: root, projectRoot: root, title: id, status: 'idle',
      lastActivity: T, startedAt: T, inputRequestedAt: null, origin: 'resume', provisional: false,
      parkedJob: null, registryStatus: null, ownedHere: true
    }
  })
  return { groups, ptys }
}
const CATALOG = catalog()
let added = 0
// Caps high enough that every row renders: the tall folder must overflow the rail on its own.
const LIMITS = { folderCap: 100, allCap: 200, autoExpand: 40 }
// `agents`: the installed agents, in the order the header logos take their slots outward from the pencil.
// `tips`: mount the app's tooltip layer. Off by default, so a label left up by a hover never paints over
// what another check reads.
const DEFAULTS = {
  mode: 'folders', density: 'compact', searchOpen: false, query: '', collapsed: {}, selected: 'atlas-3', agents: ['claude', 'codex'], tips: false
}
const noop = () => {}

function Fixture() {
  const [cfg, setCfg] = useState(DEFAULTS)
  const [pins, setPins] = useState(initialPins)
  const [rowRanks, setRowRanks] = useState({})
  const [folderRanks, setFolderRanks] = useState(initialFolderRanks)
  const [reorderTick, setReorderTick] = useState(0)
  const [revealed, setRevealed] = useState({})
  // The catalog is state so a conversation can arrive mid-drag (window.addConversation).
  const [cat, setCat] = useState(CATALOG)
  const searchRef = useRef(null)

  const search = useMemo(() => {
    const q = cfg.query.trim().toLowerCase()
    if (!q) return null
    return new Set(cat.groups.flatMap((g) => g.conversations).filter((c) => c.title.toLowerCase().includes(q)).map((c) => c.sessionId))
  }, [cfg.query, cat])
  const model = useMemo(() => buildSidebar({
    mode: cfg.mode, groups: cfg.only ? cat.groups.filter((g) => cfg.only.includes(g.root)) : cat.groups,
    ptys: cfg.only ? cat.ptys.filter((p) => cfg.only.includes(p.projectRoot)) : cat.ptys, pinned: pins, hidden: new Set(), rowRanks, folderRanks,
    liveState: (pty, _meta, id) => (pty ? LIVE[id] ?? 'quiet' : null),
    active: new Set([cfg.selected]), collapsed: cfg.collapsed, navExpanded: new Set(), activeCollapsed: new Set(),
    revealed, search, limits: LIMITS
  }), [cfg, pins, rowRanks, folderRanks, revealed, search, cat])
  const modelRef = useRef(model)
  modelRef.current = model

  // `only`: show just these folders, in this order — written as folder rank overrides, the way a drag
  // would place them, so a later folder drop still writes into the same space.
  window.configure = (next) => {
    if (next.theme) document.documentElement.dataset.theme = next.theme
    const { theme: _theme, ...rest } = next
    flushSync(() => {
      setCfg((prev) => ({ ...prev, ...rest }))
      if (next.only) setFolderRanks((prev) => ({ ...prev, ...Object.fromEntries(next.only.map((root, i) => [root, T + (next.only.length - i) * 1000 * HOUR])) }))
    })
  }
  // A new conversation in folder `root`, newer than any other, so it renders first in that folder's
  // unpinned block — a folder growing by a row mid-drag, or a block gaining a member.
  window.addConversation = (root) => {
    const n = ++added
    const seed = T + n * HOUR
    const conv = {
      sessionId: `new-${n}`, agent: 'claude', cwd: root, title: `new ${n} · Arrived mid-drag`,
      preview: 'A conversation that started while a drag was under way', gitBranch: null, mtime: seed, lastActivityAt: seed,
      messageCount: 1, version: null, sizeBytes: 0, model: null, outputTokens: 0, inputTokens: 0, contextTokens: 0, firstActivityAt: seed
    }
    flushSync(() => setCat((prev) => ({ ...prev, groups: prev.groups.map((g) => (g.root === root ? { ...g, conversations: [...g.conversations, conv] } : g)) })))
    return conv.sessionId
  }
  window.reset = () => {
    window.dropCalls = []
    window.selectCalls = []
    window.newCalls = []
    window.headNewCalls = 0
    // Each case starts with nothing focused, so a click earlier cannot carry into it.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    flushSync(() => {
      setCfg(DEFAULTS)
      setPins(initialPins())
      setRowRanks({})
      setFolderRanks(initialFolderRanks())
      setReorderTick(0)
      setRevealed({})
      setCat(CATALOG)
    })
    const body = document.querySelector('.sb-rail-body')
    if (body) body.scrollTop = 0
  }
  // The model's order, for comparing with what the DOM shows.
  window.modelOrder = () => ({
    groups: modelRef.current.groups.map((g) => g.key),
    blocks: modelRef.current.groups.flatMap((g) => g.blocks.map((b) => ({ id: b.id, rows: b.rows.map((r) => r.sessionId) })))
  })

  // App's dropRow: pins move within the one pin list, every other row writes one rank.
  const onDropRow = (block, draggedId, higherId, lowerId) => {
    window.dropCalls.push({ kind: 'row', block: block.id, blockKind: block.kind, dragged: draggedId, higher: higherId, lower: lowerId })
    if (block.kind === 'pinned') setPins((prev) => moveBetween(prev, draggedId, higherId, lowerId))
    else {
      const writes = dropWrites(rankSpace(modelRef.current), draggedId, higherId, lowerId, Date.now())
      if (Object.keys(writes).length > 0) setRowRanks((stored) => ({ ...stored, ...writes }))
    }
    setReorderTick((t) => t + 1)
  }
  // App's dropFolder: one key in the folder rank space.
  const onDropFolder = (root, higherRoot, lowerRoot) => {
    window.dropCalls.push({ kind: 'folder', block: 'folders', dragged: root, higher: higherRoot, lower: lowerRoot })
    const writes = dropWrites(folderRankSpace(modelRef.current), root, higherRoot, lowerRoot, Date.now())
    if (Object.keys(writes).length > 0) setFolderRanks((stored) => ({ ...stored, ...writes }))
    setReorderTick((t) => t + 1)
  }
  const select = (id) => {
    window.selectCalls.push(id)
    setCfg((prev) => ({ ...prev, selected: id }))
  }

  return (
    <div id="rail-host">
      <Sidebar
        model={model} mode={cfg.mode} onModeChange={(mode) => setCfg((p) => ({ ...p, mode }))} density={cfg.density}
        onNeedsYou={noop} onSetAllCollapsed={noop} loading={false} openElsewhere={new Set()}
        selectedSessionId={cfg.selected} onJump={select} onSelect={select} onTogglePin={noop}
        query={cfg.query} onQueryChange={(query) => setCfg((p) => ({ ...p, query }))} searchRef={searchRef}
        searchOpen={cfg.searchOpen} onSearchToggle={() => setCfg((p) => ({ ...p, searchOpen: !p.searchOpen, query: '' }))}
        searching={search !== null}
        onToggleFolder={(root) => setCfg((p) => ({ ...p, collapsed: { ...p.collapsed, [root]: !p.collapsed[root] } }))}
        revealed={revealed} onShowMore={(k) => setRevealed((r) => ({ ...r, [k]: (r[k] ?? 0) + 5 }))}
        onShowLess={(k) => setRevealed((r) => ({ ...r, [k]: 0 }))}
        onNewConversation={() => { window.headNewCalls++ }} agents={cfg.agents}
        onNewInFolder={(root) => window.newCalls.push({ kind: 'new', root })}
        onStartInFolder={(root, agent) => window.newCalls.push({ kind: 'start', root, agent })}
        onToggleUnread={noop} onMarkUnread={noop} onResumeSession={noop} onStopSession={noop} onShowInfo={noop}
        onDropRow={onDropRow} onDropFolder={onDropFolder} reorderTick={reorderTick}
      />
      {cfg.tips && <TooltipLayer />}
    </div>
  )
}

// A fixed-height column, so the rail body overflows and scrolls. The rail needs flex:1 / min-height:0
// inside it, or its body grows to fit and never scrolls.
const style = document.createElement('style')
style.textContent = `
  html, body { margin: 0; background: var(--paper); }
  #rail-host { position: absolute; left: 24px; top: 20px; width: 300px; height: 560px; display: flex;
    flex-direction: column; --pane-w: 300px; outline: 1px solid var(--rule-strong); }
  #rail-host > .sb-rail { flex: 1; min-height: 0; }
`
document.head.appendChild(style)
document.documentElement.dataset.theme = 'light'

// Top to bottom as rendered: folder keys, then each block's row keys.
window.order = () => {
  const body = document.querySelector('.sb-rail-body')
  const keyOf = (el) => el.dataset.key ?? el.dataset.session ?? null
  return {
    groups: [...body.querySelectorAll(':scope > section.sb-group')].map((g) => g.dataset.key ?? ''),
    blocks: [...body.querySelectorAll('.sb-block')].map((b) => ({
      id: b.dataset.block, rows: [...b.querySelectorAll(':scope > .sb-row')].map(keyOf)
    }))
  }
}

createRoot(document.querySelector('#root')).render(<Fixture />)
