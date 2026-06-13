/**
 * Read-only parsing of Claude Code session transcripts (`*.jsonl`).
 *
 * Each line of a session file is one JSON object carrying a `type`.
 * `parseTranscript` keeps the `user` / `assistant` message lines for the
 * transcript itself; `extractMeta` additionally reads a handful of metadata
 * line types (`custom-title`, `ai-title`, `summary`, `last-prompt`) for the
 * sidebar index. Everything is normalized to the shapes in `../../shared/types`.
 *
 * Pure Node — no Electron, no DOM. Malformed lines are skipped, never thrown.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type {
  ConversationMeta,
  MessageRole,
  Transcript,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/types'

/** Max characters for a cleaned title before we truncate. */
const TITLE_MAX = 80
/** Max characters for the preview line. */
const PREVIEW_MAX = 200

/** Split raw file text into non-empty lines, tolerant of CRLF and trailing newline. */
function splitLines(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

/** Parse one line as JSON, returning null on any failure (never throws). */
function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Normalize a `tool_result` content payload to a plain string. The on-disk
 * shape is EITHER a string OR an array of `{type:"text", text}` parts (and
 * occasionally other part kinds we render as their text, if any).
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
      } else if (part && typeof part === 'object') {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    return parts.join('\n')
  }
  if (content == null) return ''
  // Fallback for unexpected shapes: stringify so nothing is silently dropped.
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

/** Map a single raw content block to a normalized `TranscriptBlock`, or null to drop it. */
function normalizeBlock(raw: unknown): TranscriptBlock | null {
  if (!raw || typeof raw !== 'object') return null
  const block = raw as Record<string, unknown>
  switch (block.type) {
    case 'text': {
      const text = typeof block.text === 'string' ? block.text : ''
      return { kind: 'text', text }
    }
    // `thinking` blocks are intentionally dropped (return null below) — the Formatted view
    // never shows them.
    case 'tool_use': {
      const id = typeof block.id === 'string' ? block.id : ''
      const name = typeof block.name === 'string' ? block.name : ''
      return { kind: 'tool_use', id, name, input: block.input }
    }
    case 'tool_result': {
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
      const text = normalizeToolResultContent(block.content)
      return { kind: 'tool_result', toolUseId, text, isError: block.is_error === true }
    }
    case 'image': {
      const alt = typeof block.alt === 'string' ? block.alt : 'image'
      return { kind: 'image', alt }
    }
    default:
      return null
  }
}

/**
 * Build the normalized block list for a message line. `message.content` is
 * either a bare string (rendered as one text block) or an array of blocks.
 */
function blocksFromMessage(message: Record<string, unknown>): TranscriptBlock[] {
  const content = message.content
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : []
  }
  if (Array.isArray(content)) {
    const blocks: TranscriptBlock[] = []
    for (const raw of content) {
      const block = normalizeBlock(raw)
      if (block) blocks.push(block)
    }
    return blocks
  }
  return []
}

/** Is this a user/assistant message line we should turn into a TranscriptMessage? */
function isMessageLine(obj: Record<string, unknown>): boolean {
  return obj.type === 'user' || obj.type === 'assistant'
}

/** Extract the plain text of a user message (string content, or joined text blocks). */
function userMessageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const raw of content) {
      if (raw && typeof raw === 'object') {
        const b = raw as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
    return parts.join('\n')
  }
  return ''
}

/**
 * Clean a raw title/first-prompt string: strip slash-command wrapper tags that
 * leak in from command messages and pastes, drop surrounding backticks / code
 * fences, collapse whitespace and take the first line, then cap length.
 * Returns '' when nothing meaningful remains (callers fall through to the next
 * title source).
 */
export function cleanTitle(raw: string): string {
  if (typeof raw !== 'string') return ''
  let s = raw

  // Remove paired command wrapper tags (and their content).
  s = s.replace(/<command-message>[\s\S]*?<\/command-message>/gi, ' ')
  s = s.replace(/<command-name>[\s\S]*?<\/command-name>/gi, ' ')
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ')
  // `<command-args>` may appear with or without a closing tag.
  s = s.replace(/<command-args>[\s\S]*?<\/command-args>/gi, ' ')
  s = s.replace(/<command-args>[\s\S]*/gi, ' ')
  // Defensively strip any other leftover command-* tags (open or close).
  s = s.replace(/<\/?command-[a-z-]*>/gi, ' ')

  // Drop fenced code-block markers.
  s = s.replace(/```+/g, ' ')

  // First non-empty line.
  const firstLine = s
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  s = firstLine ?? ''

  // Trim surrounding backticks/whitespace, collapse internal whitespace.
  s = s.replace(/^[`\s]+/, '').replace(/[`\s]+$/, '')
  s = s.replace(/\s+/g, ' ').trim()

  if (s.length === 0) return ''
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX).trimEnd()
  return s
}

/** Collapse arbitrary text to a trimmed, single-line preview, capped at `max`. */
function toPreview(raw: string, max = PREVIEW_MAX): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max).trimEnd() : oneLine
}

/** Inputs collected during a scan, fed to {@link resolveTitle}. */
interface TitleSources {
  /** User-set title via `/rename` (or a forked session's auto title). Highest priority. */
  customTitle?: string | null
  aiTitle: string | null
  summary: string | null
  firstUserText: string | null
}

/**
 * Resolve the best human title from the available sources, in order:
 * last `customTitle` (/rename) -> last `aiTitle` -> last `summary` ->
 * cleaned first user message -> "Untitled". Each candidate is cleaned; empty
 * results fall through to the next source.
 */
export function resolveTitle(sources: TitleSources): string {
  const candidates = [sources.customTitle, sources.aiTitle, sources.summary, sources.firstUserText]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      const cleaned = cleanTitle(candidate)
      if (cleaned.length > 0) return cleaned
    }
  }
  return 'Untitled'
}

/**
 * Parse a full transcript: build the ordered list of user/assistant messages
 * with normalized blocks, plus the resolved title and the cwd from the file.
 * Tolerant of malformed lines (they are skipped).
 */
export async function parseTranscript(filePath: string): Promise<Transcript> {
  const sessionId = basename(filePath, '.jsonl')
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return { sessionId, cwd: '', title: 'Untitled', messages: [] }
  }

  const messages: TranscriptMessage[] = []
  let cwd = ''
  let customTitle: string | null = null
  let aiTitle: string | null = null
  let summary: string | null = null
  let firstUserText: string | null = null

  for (const line of splitLines(text)) {
    const obj = parseLine(line)
    if (!obj) continue

    if (typeof obj.cwd === 'string' && cwd === '' && obj.cwd.length > 0) {
      cwd = obj.cwd
    }

    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
      customTitle = obj.customTitle
      continue
    }
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      aiTitle = obj.aiTitle
      continue
    }
    if (obj.type === 'summary' && typeof obj.summary === 'string') {
      summary = obj.summary
      continue
    }

    if (!isMessageLine(obj)) continue

    const message = obj.message
    if (!message || typeof message !== 'object') continue
    const msg = message as Record<string, unknown>
    const role: MessageRole = msg.role === 'assistant' ? 'assistant' : 'user'

    // Attribute user lines so the renderer never labels tool output / echo as "You".
    // (classifyUserLine + hasToolResult are defined in the turn-state section below; both are
    // hoisted function declarations.) Non-conversational echo is dropped outright.
    let userKind: 'human' | 'tool_result' | 'interrupted' | undefined
    if (role === 'user') {
      const kind = classifyUserLine(obj)
      if (kind === 'noise') continue
      userKind = hasToolResult(msg) ? 'tool_result' : kind === 'interrupted' ? 'interrupted' : 'human'
    }

    // Only a genuinely typed prompt seeds the title fallback (not tool output or the sentinel).
    if (userKind === 'human' && firstUserText == null) {
      const t = userMessageText(msg)
      if (t.trim().length > 0) firstUserText = t
    }

    const blocks = blocksFromMessage(msg)
    // Skip messages with nothing left to show (e.g. an assistant turn that was ONLY thinking,
    // now removed). The interrupt sentinel renders as a fixed note, so it's exempt.
    if (blocks.length === 0 && userKind !== 'interrupted') continue

    const uuid = typeof obj.uuid === 'string' ? obj.uuid : ''
    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null
    messages.push({
      uuid,
      role,
      userKind,
      blocks,
      timestamp,
      isSidechain: obj.isSidechain === true
    })
  }

  const title = resolveTitle({ customTitle, aiTitle, summary, firstUserText })
  return { sessionId, cwd, title, messages }
}

/** Built-in tools that PARK the turn waiting for the user's reply (rather than just running). */
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * Name of the LAST `tool_use` block in an assistant message's content, or null if it has
 * none. Blocking tools are emitted as a lone, terminal tool_use (verified across every
 * occurrence on disk), so the last tool_use is the one that decides whether the turn is
 * parked on the user.
 */
function lastToolUseName(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return null
  let name: string | null = null
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use' && typeof b.name === 'string') name = b.name
    }
  }
  return name
}

/**
 * `user`-type lines Claude Code writes that are NOT a conversational turn: slash-command
 * echo / output (`/model`, `/clear`, …), `!` bash I/O, background-task notifications, and the
 * caveat injected ahead of local commands. Each is the FULL content of the line and BEGINS
 * with its wrapper tag, so the anchored test won't trip on a real prompt that merely mentions
 * one of these tags mid-text. (The caveat also carries `isMeta:true`, caught separately.)
 */
const NONCONVERSATIONAL_USER =
  /^\s*<(?:local-command-stdout|local-command-caveat|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|task-notification)>/

/** Does a user message carry a tool_result block? (Tool output the assistant acts on — a real, continuing turn.) */
function hasToolResult(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const content = (message as Record<string, unknown>).content
  if (!Array.isArray(content)) return false
  return content.some(
    (b) => b !== null && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result'
  )
}

/**
 * Classify a `user`-type transcript line for turn-state:
 *  - 'real'        — a typed prompt or a tool_result: a genuine turn (Claude is, or is about to be, working).
 *  - 'interrupted' — the "[Request interrupted by user]" sentinel: the turn was aborted (ended).
 *  - 'noise'       — slash-command / bash / task-notification / caveat echo: not a turn at all.
 */
function classifyUserLine(obj: Record<string, unknown>): 'real' | 'interrupted' | 'noise' {
  const message = obj.message
  // A tool_result is always a real, continuing turn — checked before the tag/meta tests, since
  // its result text could itself contain a wrapper tag (e.g. a Bash tool printing `<bash-stdout>`).
  if (hasToolResult(message)) return 'real'
  const text =
    message !== null && typeof message === 'object'
      ? userMessageText(message as Record<string, unknown>).trim()
      : ''
  if (text.startsWith('[Request interrupted by user')) return 'interrupted'
  if (obj.isMeta === true) return 'noise'
  if (NONCONVERSATIONAL_USER.test(text)) return 'noise'
  return 'real'
}

/**
 * Derive the coarse turn-state of a transcript from its tail, looking ONLY at the
 * main chain — sidechain / sub-agent lines are skipped, since a sub-agent finishing
 * must not look like the parent turn ending. Trailing metadata (mode, ai-title,
 * last-prompt, attachment, …) is ignored for free: it is neither a user/assistant
 * message nor a `turn_duration` system event, so it never advances the signals below.
 * Non-conversational USER lines are skipped the same way (see {@link classifyUserLine}):
 * slash-command echo/output (`/model`), `!` bash I/O, task notifications, and injected
 * caveats are not a turn, so e.g. running `/model` after a finished turn leaves the turn
 * 'awaiting', not falsely 'in_progress'.
 *
 *   - last main line is an assistant whose final tool_use BLOCKS for the user's reply
 *     (AskUserQuestion / ExitPlanMode) -> 'awaiting_input' (+ `awaitingTool`). Checked
 *     FIRST: these carry stop_reason 'tool_use' (which would otherwise read in-progress),
 *     but they wait on YOU, not on a running tool. Resolves on its own once you answer — a
 *     user tool_result is appended, flipping the tail to a user line -> 'in_progress'.
 *   - last main line is an assistant with stop_reason 'tool_use' (a non-blocking tool —
 *     running, or blocked on a permission prompt we can't see) -> 'in_progress'
 *   - last meaningful user line is a real prompt or a tool_result to act on -> 'in_progress'
 *   - last meaningful user line is an interrupt sentinel ("[Request interrupted by user]")
 *     -> 'awaiting' (the turn was aborted; modeled as a terminal turn so the preceding
 *     dangling tool_use stops reading as in-progress)
 *   - last main line is an assistant that otherwise ended (end_turn / max_tokens /
 *     an interrupted turn with no stop_reason) -> 'awaiting'
 *   - no messages at all -> undefined
 *
 * `turnEndedAt` is ms epoch (from the assistant message, or a later `turn_duration`), or
 * null when unknown / not applicable (including 'awaiting_input', where the turn has not
 * ended). `awaitingTool` is set only for 'awaiting_input'.
 */
export function extractTurnState(text: string): {
  turnState?: 'in_progress' | 'awaiting' | 'awaiting_input'
  turnEndedAt: number | null
  lastActivityAt: number | null
  awaitingTool?: 'AskUserQuestion' | 'ExitPlanMode' | null
} {
  let lastRole: 'user' | 'assistant' | null = null
  let lastAssistantStop: string | null = null
  let lastAssistantBlockingTool: string | null = null
  let lastAssistantAt = 0
  let lastTurnDurationAt = 0
  let lastMessageAt = 0

  for (const line of splitLines(text)) {
    const obj = parseLine(line)
    if (!obj || obj.isSidechain === true) continue

    // A `turn_duration` system event marks a turn boundary — record its time, then skip.
    if (obj.type === 'system') {
      if (obj.subtype === 'turn_duration' && typeof obj.timestamp === 'string') {
        const t = Date.parse(obj.timestamp)
        if (!Number.isNaN(t)) lastTurnDurationAt = t
      }
      continue
    }

    if (obj.type !== 'user' && obj.type !== 'assistant') continue

    // Skip non-conversational user lines (slash-command/bash/notification/caveat echo) so they
    // never advance the turn-state — the tail then reflects the last REAL exchange.
    let userKind: 'real' | 'interrupted' | 'noise' | null = null
    if (obj.type === 'user') {
      userKind = classifyUserLine(obj)
      if (userKind === 'noise') continue
    }

    const at = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
    if (!Number.isNaN(at)) lastMessageAt = at

    if (obj.type === 'assistant') {
      lastRole = 'assistant'
      const message = obj.message
      lastAssistantStop =
        message &&
        typeof message === 'object' &&
        typeof (message as Record<string, unknown>).stop_reason === 'string'
          ? ((message as Record<string, unknown>).stop_reason as string)
          : null
      const toolName = lastToolUseName(message)
      lastAssistantBlockingTool = toolName && BLOCKING_TOOLS.has(toolName) ? toolName : null
      if (!Number.isNaN(at)) lastAssistantAt = at
    } else if (userKind === 'interrupted') {
      // Esc mid-turn aborts it. Model it as a terminal (ended) turn so the dangling assistant
      // tool_use that precedes the interrupt stops reading as in-progress.
      lastRole = 'assistant'
      lastAssistantStop = 'end_turn'
      lastAssistantBlockingTool = null
      if (!Number.isNaN(at)) lastAssistantAt = at
    } else {
      lastRole = 'user'
    }
  }

  const lastActivityAt = lastMessageAt > 0 ? lastMessageAt : null

  if (lastRole === 'assistant') {
    // Parked on a tool that blocks for the user's reply (AskUserQuestion / ExitPlanMode).
    // Checked before the generic tool_use case below: these carry stop_reason 'tool_use'
    // (which would read as in-progress) but they wait on YOU, not on a running tool.
    if (lastAssistantBlockingTool != null) {
      return {
        turnState: 'awaiting_input',
        turnEndedAt: null,
        lastActivityAt,
        awaitingTool: lastAssistantBlockingTool as 'AskUserQuestion' | 'ExitPlanMode'
      }
    }
    // Claude writes assistant messages as STREAMING FRAGMENTS — a partial line carries no
    // stop_reason yet — so a missing stop_reason means "still generating", and `tool_use` /
    // `pause_turn` mean "more is coming": all in-progress. Only a terminal stop_reason
    // (end_turn / stop_sequence / max_tokens / refusal / …) means the turn handed back to the
    // user. (Caveat: an interrupted turn also lacks a terminal stop_reason, so it reads as
    // in-progress until the next event; the hook-based signal will resolve that ambiguity.)
    const continuing =
      lastAssistantStop == null ||
      lastAssistantStop === 'tool_use' ||
      lastAssistantStop === 'pause_turn'
    if (continuing) return { turnState: 'in_progress', turnEndedAt: null, lastActivityAt }
    const endedAt = Math.max(lastAssistantAt, lastTurnDurationAt)
    return { turnState: 'awaiting', turnEndedAt: endedAt > 0 ? endedAt : null, lastActivityAt }
  }
  if (lastRole === 'user') return { turnState: 'in_progress', turnEndedAt: null, lastActivityAt }
  return { turnState: undefined, turnEndedAt: null, lastActivityAt }
}

/** A finite number, or 0 — for reading optional numeric `usage` fields without NaN poisoning a sum. */
function numField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Efficient metadata-only pass for the sidebar. Returns null when the file has
 * no parseable content or no cwd (cwd is the source of truth for grouping).
 */
export async function extractMeta(filePath: string): Promise<ConversationMeta | null> {
  const sessionId = basename(filePath, '.jsonl')

  let text: string
  let mtime: number
  let sizeBytes: number
  try {
    const [content, stats] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
    text = content
    mtime = stats.mtimeMs
    sizeBytes = stats.size
  } catch {
    return null
  }

  let cwd: string | null = null
  let customTitle: string | null = null
  let aiTitle: string | null = null
  let summary: string | null = null
  let firstUserText: string | null = null
  let lastPrompt: string | null = null
  let gitBranch: string | null = null
  let version: string | null = null
  let messageCount = 0
  let model: string | null = null
  let outputTokens = 0
  let inputTokens = 0
  let firstActivityAt: number | null = null

  for (const line of splitLines(text)) {
    const obj = parseLine(line)
    if (!obj) continue

    if (cwd == null && typeof obj.cwd === 'string' && obj.cwd.length > 0) {
      cwd = obj.cwd
    }
    if (typeof obj.gitBranch === 'string') gitBranch = obj.gitBranch
    if (typeof obj.version === 'string') version = obj.version

    switch (obj.type) {
      case 'custom-title':
        if (typeof obj.customTitle === 'string') customTitle = obj.customTitle
        continue
      case 'ai-title':
        if (typeof obj.aiTitle === 'string') aiTitle = obj.aiTitle
        continue
      case 'summary':
        if (typeof obj.summary === 'string') summary = obj.summary
        continue
      case 'last-prompt':
        if (typeof obj.lastPrompt === 'string') lastPrompt = obj.lastPrompt
        continue
      case 'user':
      case 'assistant':
        break
      default:
        continue
    }

    messageCount += 1

    // First/last message timestamps bound the conversation's elapsed span (Duration in the info modal).
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN
    if (!Number.isNaN(ts) && firstActivityAt == null) firstActivityAt = ts

    const message = obj.message
    if (obj.type === 'user' && firstUserText == null && message && typeof message === 'object') {
      const t = userMessageText(message as Record<string, unknown>)
      if (t.trim().length > 0) firstUserText = t
    }

    // Per-turn model + token usage, summed across the conversation (assistant lines only). `usage`
    // shape: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens }.
    if (obj.type === 'assistant' && message && typeof message === 'object') {
      const m = message as Record<string, unknown>
      if (typeof m.model === 'string' && m.model.length > 0 && m.model !== '<synthetic>') model = m.model
      const usage = m.usage
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>
        outputTokens += numField(u.output_tokens)
        inputTokens +=
          numField(u.input_tokens) +
          numField(u.cache_creation_input_tokens) +
          numField(u.cache_read_input_tokens)
      }
    }
  }

  if (cwd == null) return null

  const title = resolveTitle({ customTitle, aiTitle, summary, firstUserText })
  const previewSource = lastPrompt ?? firstUserText ?? ''
  const preview = toPreview(previewSource)
  const { turnState, turnEndedAt, lastActivityAt, awaitingTool } = extractTurnState(text)

  return {
    sessionId,
    cwd,
    title,
    preview,
    gitBranch,
    mtime,
    messageCount,
    version,
    sizeBytes,
    model,
    outputTokens,
    inputTokens,
    firstActivityAt,
    turnState,
    turnEndedAt,
    lastActivityAt,
    awaitingTool,
    provisional: false
  }
}
