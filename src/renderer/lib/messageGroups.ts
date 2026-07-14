// Imports the shared contract by RELATIVE path (not the `@shared` alias) so this stays
// unit-testable under vitest, which has no alias resolution. (Same reason as liveness.ts.)
import { AGENTS, type AgentKind, type TranscriptBlock, type TranscriptMessage } from '../../shared/types'

/**
 * The transcript renders as an ordered list of RenderItems, NOT one-per-message:
 *   - `turn`      — a prose beat: a human prompt ("You"), or the agent's narration text
 *                   ('Claude' / 'Codex'). Consecutive same-source prose coalesces into one.
 *   - `toolrun`   — a maximal run of consecutive tool activity (tool_use calls + their
 *                   tool_result outputs), collapsed behind a single "⚙ N tool calls" disclosure.
 *                   A run crosses assistant-message boundaries (Claude fires each tool in its own
 *                   message) and is broken only by prose, a human turn, an interrupt, or a
 *                   main↔sidechain switch. The agent's narration text is split OUT of its message
 *                   into a preceding `turn`, so "Now applying the edits." stays visible while the
 *                   edits themselves fold into the run.
 *   - `interrupt` — the Esc sentinel, a standalone muted note.
 */
export interface ToolCall {
  /** tool_use id — the pairing key against a result's toolUseId. */
  id: string
  name: string
  input: unknown
}

export interface ToolResult {
  text: string
  isError: boolean
}

/** One call paired with its result. `result` is null for a still-pending call (live turn / blocking
 *  tool); `call` is null for an orphan result (a call compacted/truncated away — rare). */
export interface ToolPair {
  key: string
  call: ToolCall | null
  result: ToolResult | null
}

export interface TurnItem {
  kind: 'turn'
  key: string
  /** 'You' | the agent's assistant label ('Claude' | 'Codex'). */
  label: string
  /** True when the agent authored it (drives the "Copy turn" affordance without string-matching). */
  isAssistant: boolean
  isSidechain: boolean
  /** The coalesced messages, each with blocks filtered to PROSE only (text / image) — the tool_use
   *  blocks have been peeled off into runs. Kept as messages so turnMarkdown + timestamps still work. */
  messages: TranscriptMessage[]
  timestamp: string | null
}

export interface ToolRunItem {
  kind: 'toolrun'
  key: string
  isSidechain: boolean
  pairs: ToolPair[]
  /** Number of tool CALLS in the run — what the collapsed row counts ("N tool calls"). */
  count: number
  timestamp: string | null
}

export interface InterruptItem {
  kind: 'interrupt'
  key: string
}

export type RenderItem = TurnItem | ToolRunItem | InterruptItem

/** A contiguous same-author section — ONE header for a whole "who's speaking" stretch. An agent
 *  section bundles the agent's prose beats AND its tool runs (so repeated "Claude" headers collapse to
 *  one); a You section holds the human turn. Interrupts stay standalone. Section breaks land exactly on
 *  the You↔agent boundaries the transcript divider already marks. */
export interface Section {
  kind: 'section'
  key: string
  label: string
  isAssistant: boolean
  isSidechain: boolean
  /** The transcript's agent — so an assistant section's header can render the right logo. */
  agent: AgentKind
  items: (TurnItem | ToolRunItem)[]
  timestamp: string | null
}

/** What the transcript maps over: a same-author section, or a standalone interrupt note. */
export type TranscriptItem = Section | InterruptItem

type ToolUseBlock = Extract<TranscriptBlock, { kind: 'tool_use' }>
type ToolResultBlockT = Extract<TranscriptBlock, { kind: 'tool_result' }>

const isProse = (b: TranscriptBlock): boolean => b.kind === 'text' || b.kind === 'image'
const isToolUse = (b: TranscriptBlock): b is ToolUseBlock => b.kind === 'tool_use'
const isToolResult = (b: TranscriptBlock): b is ToolResultBlockT => b.kind === 'tool_result'

/**
 * Build the ordered RenderItems from the flat message list. Single O(n) pass with an open tool-run
 * accumulator that flushes whenever prose / a human turn / an interrupt / a sidechain switch breaks
 * the run. Pairs calls to results by id at flush time.
 *
 * `agent` selects the assistant label ('Claude' / 'Codex'); defaults to 'claude' so legacy callers
 * (and tests) work unchanged.
 */
export function buildRenderItems(
  messages: TranscriptMessage[],
  agent: AgentKind = 'claude'
): RenderItem[] {
  const items: RenderItem[] = []
  const assistantLabel = AGENTS[agent].assistantLabel

  // ---- open tool-run accumulator ----
  let calls: ToolCall[] = []
  let results: { toolUseId: string; text: string; isError: boolean }[] = []
  let runSidechain = false
  let runTs: string | null = null
  let runOpen = false
  let seq = 0

  const flushRun = (): void => {
    if (!runOpen) return
    const used = new Array(results.length).fill(false)
    const pairs: ToolPair[] = []
    // Each call, in order, takes the first unused result with a matching id (handles parallel calls
    // whose results arrive batched). Empty ids never match, so a call with no id stays "pending".
    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i]
      let result: ToolResult | null = null
      if (call.id !== '') {
        const ri = results.findIndex((r, idx) => !used[idx] && r.toolUseId === call.id)
        if (ri >= 0) {
          used[ri] = true
          result = { text: results[ri].text, isError: results[ri].isError }
        }
      }
      pairs.push({ key: call.id || `call${i}`, call, result })
    }
    // Orphan results (no matching call — truncation / compaction edge) render on their own.
    for (let i = 0; i < results.length; i += 1) {
      if (!used[i]) {
        pairs.push({ key: `orphan${i}`, call: null, result: { text: results[i].text, isError: results[i].isError } })
      }
    }
    items.push({
      kind: 'toolrun',
      key: calls[0]?.id || results[0]?.toolUseId || `run${seq++}`,
      isSidechain: runSidechain,
      pairs,
      count: calls.length || results.length,
      timestamp: runTs
    })
    calls = []
    results = []
    runOpen = false
    runTs = null
  }

  const openRun = (sidechain: boolean, ts: string | null): void => {
    // A main↔sidechain switch never merges — flush the open run first.
    if (runOpen && runSidechain !== sidechain) flushRun()
    if (!runOpen) {
      runOpen = true
      runSidechain = sidechain
      runTs = ts
    }
  }

  const appendTurn = (
    label: string,
    isAssistant: boolean,
    sidechain: boolean,
    m: TranscriptMessage,
    blocks: TranscriptBlock[]
  ): void => {
    const msg: TranscriptMessage = { ...m, blocks }
    const last = items[items.length - 1]
    if (last && last.kind === 'turn' && last.label === label && last.isSidechain === sidechain) {
      last.messages.push(msg)
      return
    }
    items.push({
      kind: 'turn',
      key: m.uuid || `turn${items.length}`,
      label,
      isAssistant,
      isSidechain: sidechain,
      messages: [msg],
      timestamp: m.timestamp ?? null
    })
  }

  for (const m of messages) {
    if (m.userKind === 'interrupted') {
      flushRun()
      items.push({ kind: 'interrupt', key: m.uuid || `int${items.length}` })
      continue
    }

    if (m.role === 'user' && m.userKind === 'tool_result') {
      const rblocks = m.blocks.filter(isToolResult)
      if (rblocks.length > 0) {
        openRun(m.isSidechain, m.timestamp)
        for (const b of rblocks) results.push({ toolUseId: b.toolUseId, text: b.text, isError: b.isError })
      }
      continue
    }

    if (m.role === 'user') {
      // A typed human prompt — its own "You" turn; ends any open run.
      flushRun()
      appendTurn('You', false, m.isSidechain, m, m.blocks.filter(isProse))
      continue
    }

    // assistant: narration text splits into a prose turn (breaking the run); tool calls join the run.
    const prose = m.blocks.filter(isProse)
    const tools = m.blocks.filter(isToolUse)
    if (prose.length > 0) {
      flushRun()
      appendTurn(assistantLabel, true, m.isSidechain, m, prose)
    }
    if (tools.length > 0) {
      openRun(m.isSidechain, m.timestamp)
      for (const b of tools) calls.push({ id: b.id, name: b.name, input: b.input })
    }
  }
  flushRun()
  return items
}

/**
 * Group the flat render items into same-author sections (one header each). Consecutive items on the
 * same side (You vs agent) with the same sidechain flag coalesce; interrupts pass through standalone.
 * `agent` supplies the section label for an agent section that BEGINS with a tool run (no prose to
 * name it). The section break lands on every You↔agent transition — the same boundary the divider marks.
 */
export function groupSections(items: RenderItem[], agent: AgentKind = 'claude'): TranscriptItem[] {
  const assistantLabel = AGENTS[agent].assistantLabel
  const out: TranscriptItem[] = []
  for (const item of items) {
    if (item.kind === 'interrupt') {
      out.push(item)
      continue
    }
    const isAssistant = !(item.kind === 'turn' && item.label === 'You')
    const last = out[out.length - 1]
    if (
      last &&
      last.kind === 'section' &&
      last.isAssistant === isAssistant &&
      last.isSidechain === item.isSidechain
    ) {
      last.items.push(item)
      continue
    }
    out.push({
      kind: 'section',
      key: item.key,
      label: isAssistant ? assistantLabel : 'You',
      isAssistant,
      isSidechain: item.isSidechain,
      agent,
      items: [item],
      timestamp: item.timestamp
    })
  }
  return out
}

/** The transcript's render list: flat items grouped into same-author sections, in one call. */
export function buildTranscript(messages: TranscriptMessage[], agent: AgentKind = 'claude'): TranscriptItem[] {
  return groupSections(buildRenderItems(messages, agent), agent)
}
