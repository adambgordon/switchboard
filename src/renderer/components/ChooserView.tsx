import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject
} from 'react'
import { AGENTS, type AgentKind } from '@shared/types'
import { filterChooserFolders, type ChooserFolder } from '../lib/chooserDirs'
import { chooserAgent, type ChooserMemory } from '../lib/chooserTab'
import { basename, relTime } from '../lib/format'
import { useAutoHideScrollbar } from '../lib/useAutoHideScrollbar'
import AgentLogo from './AgentLogo'
import { Folder, Plus, Search } from './icons'

interface Props {
  /** The chooser tab's id — namespaces the row ids the filter field points at. */
  id: string
  /** The folders to offer, ranked, the preselect first (`chooserDirs`). */
  folders: readonly ChooserFolder[]
  /** Bumped each time a folder's pencil re-aims this chooser: the filter clears and the highlight returns
   *  to the first row — the folder asked for — so Enter starts where the pencil pointed. */
  aim: number
  /** Launchable agents. With fewer than two there is no choice to show. */
  agents: AgentKind[]
  /** The agent it opens on: an enabled default, else the last one picked. */
  initialAgent: AgentKind
  onAgentChange: (agent: AgentKind) => void
  /** Start here. Rejects when it could not (the folder is gone), which re-arms the chooser. */
  onStart: (dir: string, agent: AgentKind) => Promise<void>
  onPickOther: (agent: AgentKind) => Promise<void>
  /** Esc on an empty filter: leave the chooser. */
  onDismiss: () => void
  /** Bumped when this chooser should take the keyboard; null while its pane does not have it. */
  focusKey: number | null
  /** Each chooser's memory, held above the view so a remount picks up where the user left off. */
  memory: MutableRefObject<Map<string, ChooserMemory>>
}

const OTHER = '\0other'

/**
 * The new-conversation chooser, filling its pane: a quiet launcher — pick an agent, type to narrow the
 * folders, Enter. The filter field keeps the keyboard throughout, so typing always filters; the arrow
 * keys move a highlight the field points at (`aria-activedescendant`) rather than moving focus away.
 *
 * Only while mounted does any of this cost anything: the folder list is computed upstream for a chooser
 * on screen, and a keystroke filters that in-memory list — no index, transcript or terminal is touched.
 */
export default function ChooserView({
  id,
  folders,
  aim,
  agents,
  initialAgent,
  onAgentChange,
  onStart,
  onPickOther,
  onDismiss,
  focusKey,
  memory
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useAutoHideScrollbar(listRef)
  const [saved] = useState(() => memory.current.get(id))
  const [query, setQuery] = useState(saved?.query ?? '')
  const [picked, setPicked] = useState(saved?.picked ?? null)
  const agent = chooserAgent(picked ?? initialAgent, agents, initialAgent)
  // The highlighted folder, by path rather than by position, so a list re-ranked by index activity
  // behind the user keeps the same folder under the cursor. Null means the first row.
  const [highlight, setHighlight] = useState(saved?.highlight ?? null)
  // A start in flight: a second Enter must not spawn a second conversation.
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const shown = useMemo(() => filterChooserFolders(folders, query), [folders, query])
  const rows = useMemo(() => [...shown.map((f) => f.dir), OTHER], [shown])
  const index = Math.max(0, highlight === null ? 0 : rows.indexOf(highlight))
  const current = rows[index]

  const remember = (patch: Partial<ChooserMemory>): void => {
    const prev = memory.current.get(id) ?? { focus: null, query: '', highlight: null, picked: null }
    memory.current.set(id, { ...prev, ...patch })
  }

  // Only a change: the pencil re-aims a chooser only while it is on screen, so a remount has nothing to
  // take, and must not clear what it just restored.
  const aimSeen = useRef(aim)
  useEffect(() => {
    if (aimSeen.current === aim) return
    aimSeen.current = aim
    setQuery('')
    setHighlight(null)
  }, [aim])

  useEffect(() => {
    remember({ query, highlight, picked })
  }, [query, highlight, picked])

  useEffect(() => {
    if (focusKey === null || memory.current.get(id)?.focus === focusKey) return
    remember({ focus: focusKey })
    inputRef.current?.focus({ preventScroll: true })
  }, [focusKey, id, memory])

  // The highlight is kept in view when the keys or the filter move it — never when the pointer does. A
  // row the pointer reaches is already under it; scrolling a half-shown one into view would slide the
  // next row under the pointer, highlight that, and so run the list on by itself.
  const pointerMoved = useRef(false)
  useEffect(() => {
    if (pointerMoved.current) {
      pointerMoved.current = false
      return
    }
    listRef.current?.querySelector<HTMLElement>('[data-highlight]')?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const pointAt = (dir: string): void => {
    if (dir === current) return
    pointerMoved.current = true
    setHighlight(dir)
  }

  const pickAgent = (a: AgentKind): void => {
    setPicked(a)
    onAgentChange(a)
  }

  const run = (dir: string): void => {
    if (starting) return
    setStarting(true)
    setFailed(null)
    const done = dir === OTHER ? onPickOther(agent) : onStart(dir, agent)
    // On success this tab becomes the conversation and unmounts; only a failure (or a canceled
    // folder picker) comes back here, and that must leave the chooser usable.
    void done
      .then(() => setStarting(false))
      .catch(() => {
        setStarting(false)
        if (dir !== OTHER) setFailed(dir)
      })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Mid-composition keys belong to the input method: its Enter accepts a candidate, not a folder.
    if (e.metaKey || e.ctrlKey || e.altKey || e.nativeEvent.isComposing) return
    // Handled keys stop here, so the window-level handler does not also act on them — Esc clearing the
    // rail's search, arrows walking the rail.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const next = (index + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      setHighlight(rows[next])
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      run(current)
    } else if (
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
      query === '' &&
      agents.length > 1
    ) {
      // Only on an empty field: once there is text, ←/→ belong to the caret.
      e.preventDefault()
      e.stopPropagation()
      const i = agents.indexOf(agent)
      pickAgent(agents[(i + (e.key === 'ArrowRight' ? 1 : -1) + agents.length) % agents.length])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) {
        setQuery('')
        setHighlight(null)
      } else onDismiss()
    }
  }

  const rowId = (dir: string): string => `${id}-row-${rows.indexOf(dir)}`
  const now = Date.now()

  // The filter is the chooser's keyboard, so a press anywhere else in the pane — the empty space around
  // the column, the title, the hints — keeps it (or hands it back) rather than stranding the keys on the
  // pane. The field itself and the list's scrollbar keep their own behavior.
  const keepFilterFocus = (e: MouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement
    if (t === inputRef.current) return
    if (t === listRef.current && e.nativeEvent.offsetX >= t.clientWidth) return
    e.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="sb-chooser" aria-busy={starting || undefined} onMouseDown={keepFilterFocus}>
      <div className="sb-chooser-col">
        <div className="sb-chooser-head">
          <h1 className="sb-chooser-title">New conversation</h1>
          {agents.length > 1 ? (
            <div className="sb-seg sb-chooser-agents" role="radiogroup" aria-label="Agent">
              {agents.map((a) => (
                <button
                  key={a}
                  type="button"
                  role="radio"
                  aria-checked={agent === a}
                  className={`sb-seg-btn${agent === a ? ' active' : ''}`}
                  onClick={() => pickAgent(a)}
                >
                  <AgentLogo agent={a} size={13} decorative />
                  <span>{AGENTS[a].label}</span>
                </button>
              ))}
            </div>
          ) : agents.length === 1 ? (
            <div className="sb-chooser-agent">
              <AgentLogo agent={agents[0]} size={13} decorative />
              <span>{AGENTS[agents[0]].label}</span>
            </div>
          ) : null}
        </div>
        <label className="sb-chooser-filter">
          <Search size={14} />
          <input
            ref={inputRef}
            className="sb-chooser-input"
            placeholder="Filter folders"
            value={query}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={rowId(current)}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(null)
            }}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className="sb-chooser-list sb-autoscroll" id={`${id}-list`} role="listbox" ref={listRef}>
          {shown.length === 0 && (
            <div className="sb-chooser-empty">{query ? 'No folder matches' : 'No recent folders'}</div>
          )}
          {shown.map((f) => (
            <div
              key={f.dir}
              id={rowId(f.dir)}
              role="option"
              aria-selected={f.dir === current}
              data-highlight={f.dir === current || undefined}
              className={`sb-chooser-row${f.dir === failed ? ' failed' : ''}`}
              // Mouse-move, not enter: a list scrolling under a still pointer must not move the highlight.
              onMouseMove={() => pointAt(f.dir)}
              onClick={() => run(f.dir)}
            >
              <Folder size={14} className="sb-chooser-folder" />
              <span className="sb-chooser-name truncate">{basename(f.dir)}</span>
              <span className="sb-chooser-path truncate">{f.dir === failed ? 'Couldn’t start here' : f.dir}</span>
              <span className="sb-chooser-when">{f.startedAt > 0 ? relTime(f.startedAt, now) : ''}</span>
            </div>
          ))}
        </div>
        <div
          id={rowId(OTHER)}
          role="option"
          aria-selected={current === OTHER}
          data-highlight={current === OTHER || undefined}
          className="sb-chooser-row sb-chooser-other"
          onMouseMove={() => pointAt(OTHER)}
          onClick={() => run(OTHER)}
        >
          <Plus size={14} className="sb-chooser-folder" />
          <span>Choose another folder…</span>
        </div>
        <div className="sb-chooser-keys label-caps" aria-hidden="true">
          <span><kbd>↵</kbd> start</span>
          <span><kbd>↑</kbd><kbd>↓</kbd> folder</span>
          {agents.length > 1 && <span><kbd>←</kbd><kbd>→</kbd> agent</span>}
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
