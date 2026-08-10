/**
 * Read-only parsing of Codex session rollouts
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`).
 *
 * Each line is `{ timestamp, type, payload }`. Three shapes matter:
 *   - `response_item` — the canonical model thread (OpenAI Responses API items): assistant/user
 *     `message`s, `reasoning` (dropped, like Claude "thinking"), `function_call` /
 *     `function_call_output`, `custom_tool_call` / `custom_tool_call_output`, `web_search_call`.
 *   - `event_msg` per-kind content events — `user_message` (the clean human prompt) and
 *     `agent_message` (assistant final text — redundant with the response_item assistant message,
 *     so dropped from the transcript).
 *   - `event_msg/item_completed` — a later unified envelope that folds those per-kind content
 *     events into ONE event discriminated by `item.type`: `UserMessage`, `AgentMessage`,
 *     `Reasoning`, `CommandExecution`, `Extension`, `McpToolCall`, `FileChange`. Top-level threads
 *     emit this INSTEAD of `user_message`/`agent_message`; subagent rollouts still emit the
 *     per-kind events, so both shapes have to be read. Only `UserMessage` is read for content —
 *     every other item mirrors a `response_item` line, so reading them would duplicate the
 *     transcript.
 *
 * Orthogonal to all three: `token_count` and the `task_started`/`task_complete`/`turn_aborted`
 * turn boundaries, which the envelope did not change.
 *
 * The transcript walks lines in order and emits: human turns from whichever human-turn stream the
 * rollout carries (the de-noised prompt — the response_item user messages carry injected
 * <environment_context>/AGENTS.md blocks, so they're skipped), assistant text from response_item
 * assistant messages, and tool calls/results from function_call(+custom/web)/function_call_output.
 * These map onto the same normalized tool_use/tool_result block shapes as the Claude parser, so the
 * renderer is shared. Should a rollout ever carry BOTH human-turn streams, the per-kind
 * `user_message` wins: reading both would double every prompt.
 *
 * Only INTERACTIVE sessions (`session_meta.originator === 'codex-tui'`) are parsed into metadata;
 * `codex exec` / non-interactive rollouts (originator `codex_exec`) are dropped. The indexer then
 * removes interactive subagent threads using `session_meta.thread_source`.
 *
 * Pure Node — no Electron, no DOM. Malformed lines are skipped, never thrown. The `*FromText`
 * functions are pure (string in, value out) so they're unit-testable without the filesystem.
 */

import { readFile, stat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  ConversationMeta,
  MessageRole,
  Transcript,
  TranscriptBlock,
  TranscriptMessage
} from '../../shared/types'
import { isConversationalMessage } from '../../shared/messageCount'
import { cleanTitle } from './parser'

/** Default Codex sessions root: `~/.codex/sessions`. */
export function defaultCodexRoot(): string {
  return path.join(homedir(), '.codex', 'sessions')
}

const PREVIEW_MAX = 200

function splitLines(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function numField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function toPreview(raw: string, max = PREVIEW_MAX): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max).trimEnd() : oneLine
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Join Responses-API message content (string, or an array of `{ text }` parts) into one string. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const raw of content) {
      const p = asRecord(raw)
      if (p && typeof p.text === 'string') parts.push(p.text)
    }
    return parts.join('\n')
  }
  return ''
}

/** The `item.type` discriminant on an `item_completed` payload, or '' when there isn't one. */
function itemType(payload: Record<string, unknown>): string {
  const item = asRecord(payload.item)
  return item != null && typeof item.type === 'string' ? item.type : ''
}

/**
 * Does this rollout carry the per-kind `event_msg/user_message` stream? When it does, the
 * `item_completed` envelope's `UserMessage` items must be ignored so a prompt is never read twice.
 *
 * The substring test is only a cheap pre-filter, and every candidate line is then parsed and
 * verified to really BE the event. Prose that quotes the term is harmless — JSON escapes its quotes
 * — but any unescaped string or array value equal to the bare token serializes to the same
 * characters (a search query for `user_message`, say). Trusting the substring alone would read such
 * a rollout as having the per-kind stream and silently drop every one of its human turns: the exact
 * bug this guard exists to prevent.
 */
function hasLegacyUserStream(lines: readonly string[]): boolean {
  return lines.some((line) => {
    if (!line.includes('"user_message"')) return false
    const obj = parseLine(line)
    if (obj == null || obj.type !== 'event_msg') return false
    return asRecord(obj.payload)?.type === 'user_message'
  })
}

/**
 * The clean human prompt carried by an `event_msg` line, or '' when the line isn't a human turn.
 *
 * Reads both stream shapes: the per-kind `user_message` event, and the unified `item_completed`
 * envelope's `UserMessage` item. `allowItemStream` is false when the rollout also has the per-kind
 * stream (see {@link hasLegacyUserStream}).
 *
 * An attached image is a SIBLING `{ type: 'local_image', path }` content part, and the `text` part
 * already carries that image's `[Image #N]` placeholder inline — so joining the text parts
 * reproduces the `user_message` string exactly, and no separate image block belongs here.
 */
function humanTurnText(payload: Record<string, unknown>, allowItemStream: boolean): string {
  if (payload.type === 'user_message') {
    return typeof payload.message === 'string' ? payload.message : ''
  }
  if (!allowItemStream || payload.type !== 'item_completed') return ''
  if (itemType(payload) !== 'UserMessage') return ''
  return contentText(asRecord(payload.item)?.content)
}

/** A `function_call`'s `arguments` is a JSON string; parse it for nicer rendering, else keep raw. */
function parseArgs(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch {
      return args
    }
  }
  return args ?? null
}

/** Normalize a tool-call output payload to a plain string (string, or a stringified object). */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output == null) return ''
  const rec = asRecord(output)
  if (rec) {
    if (typeof rec.output === 'string') return rec.output
    if (typeof rec.content === 'string') return rec.content
    if (typeof rec.text === 'string') return rec.text
  }
  return safeStringify(output)
}

/** The session id is the trailing UUID of `rollout-<ISO>-<uuid>.jsonl` (the ISO also has dashes). */
export function sessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl')
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)
  return m ? m[1] : base
}

/**
 * Build the normalized transcript from a rollout's text. Pure. Tool calls become assistant
 * `tool_use` messages and tool outputs become `tool_result` user messages, so `buildGroups`
 * coalesces them into "Codex" / "Result" / "Error" groups exactly like the Claude path.
 */
export function parseCodexTranscriptText(text: string, sessionId: string): Transcript {
  let cwd = ''
  let firstUser: string | null = null
  const messages: TranscriptMessage[] = []
  let seq = 0
  const add = (
    role: MessageRole,
    blocks: TranscriptBlock[],
    timestamp: string | null,
    userKind?: TranscriptMessage['userKind'],
    preferredId?: string
  ): void => {
    if (blocks.length === 0) return
    const uuid = preferredId && preferredId.length > 0 ? preferredId : `c${seq}`
    seq += 1
    messages.push({ uuid, role, userKind, blocks, timestamp, isSidechain: false })
  }

  const lines = splitLines(text)
  const allowItemStream = !hasLegacyUserStream(lines)

  for (const line of lines) {
    const obj = parseLine(line)
    if (!obj) continue
    const payload = asRecord(obj.payload)
    if (!payload) continue
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null

    if (obj.type === 'session_meta' || obj.type === 'turn_context') {
      if (cwd === '' && typeof payload.cwd === 'string' && payload.cwd.length > 0) cwd = payload.cwd
      continue
    }

    if (obj.type === 'event_msg') {
      const msgText = humanTurnText(payload, allowItemStream)
      if (msgText.trim().length > 0) {
        if (firstUser == null) firstUser = msgText
        add('user', [{ kind: 'text', text: msgText }], ts, 'human')
      }
      // agent_message duplicates the response_item assistant text; every non-UserMessage
      // item_completed likewise mirrors a response_item line; token_count / task_* are not
      // transcript content — all skipped here.
      continue
    }

    if (obj.type !== 'response_item') continue

    const ptype = payload.type
    if (ptype === 'message') {
      // Only assistant text. The response_item user/developer messages are injected context
      // (<environment_context>, AGENTS.md, permission blocks); the clean prompt comes from the
      // event_msg/user_message above.
      if (payload.role === 'assistant') {
        const txt = contentText(payload.content)
        if (txt.trim().length > 0) {
          const id = typeof payload.id === 'string' ? payload.id : undefined
          add('assistant', [{ kind: 'text', text: txt }], ts, undefined, id)
        }
      }
      continue
    }

    if (ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'web_search_call') {
      const name =
        typeof payload.name === 'string' && payload.name.length > 0
          ? payload.name
          : ptype === 'web_search_call'
            ? 'web_search'
            : 'tool'
      const id =
        typeof payload.call_id === 'string'
          ? payload.call_id
          : typeof payload.id === 'string'
            ? payload.id
            : ''
      const input =
        ptype === 'web_search_call'
          ? (payload.action ?? payload.query ?? null)
          : payload.arguments !== undefined
            ? parseArgs(payload.arguments)
            : (payload.input ?? null)
      add('assistant', [{ kind: 'tool_use', id, name, input }], ts, undefined, id || undefined)
      continue
    }

    if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
      const id = typeof payload.call_id === 'string' ? payload.call_id : ''
      const text2 = outputText(payload.output)
      const isError = payload.success === false
      add('user', [{ kind: 'tool_result', toolUseId: id, text: text2, isError }], ts, 'tool_result')
      continue
    }
    // reasoning + any other response_item kind: dropped.
  }

  const title = cleanTitle(firstUser ?? '') || 'Untitled'
  return { sessionId, agent: 'codex', cwd, title, messages }
}

/**
 * Metadata-only pass for the sidebar. Pure. Returns null for non-interactive rollouts
 * (originator !== 'codex-tui') and for rollouts with no cwd. Tokens come from the LAST
 * `token_count` event; turn-state from the task lifecycle plus a pending `request_user_input`.
 */
export function extractCodexMetaFromText(
  text: string,
  sessionId: string,
  mtime: number,
  sizeBytes: number
): ConversationMeta | null {
  let cwd: string | null = null
  let originator: string | null = null
  let threadSource: string | null = null
  let version: string | null = null
  let model: string | null = null
  let firstUser: string | null = null
  let lastUser: string | null = null
  let messageCount = 0
  let firstActivityAt: number | null = null
  let lastActivityAt: number | null = null

  // tokens — the last token_count wins (each is a cumulative snapshot).
  let outputTokens = 0
  let inputTokens = 0
  let cachedInputTokens = 0
  let reasoningTokens = 0
  let contextTokens = 0
  let contextWindow = 0

  // turn-state — driven by file-order task lifecycle + a pending request_user_input.
  let inTurn = false
  let turnEndedAt: number | null = null
  const openUserInputCalls = new Set<string>()

  const lines = splitLines(text)
  const allowItemStream = !hasLegacyUserStream(lines)

  for (const line of lines) {
    const obj = parseLine(line)
    if (!obj) continue
    const payload = asRecord(obj.payload)
    if (!payload) continue
    const at = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN

    if (obj.type === 'session_meta') {
      if (cwd == null && typeof payload.cwd === 'string' && payload.cwd.length > 0) cwd = payload.cwd
      if (originator == null && typeof payload.originator === 'string') originator = payload.originator
      if (threadSource == null && typeof payload.thread_source === 'string') {
        threadSource = payload.thread_source
      }
      if (version == null && typeof payload.cli_version === 'string') version = payload.cli_version
      continue
    }
    if (obj.type === 'turn_context') {
      if (cwd == null && typeof payload.cwd === 'string' && payload.cwd.length > 0) cwd = payload.cwd
      if (typeof payload.model === 'string' && payload.model.length > 0) model = payload.model
      continue
    }

    if (obj.type === 'event_msg') {
      const pt = payload.type
      const m = humanTurnText(payload, allowItemStream)
      if (m.trim().length > 0) {
        if (firstUser == null) firstUser = m
        lastUser = m
        if (
          isConversationalMessage({
            role: 'user',
            userKind: 'human',
            blocks: [{ kind: 'text', text: m }]
          })
        ) {
          messageCount += 1
        }
        if (!Number.isNaN(at)) {
          if (firstActivityAt == null) firstActivityAt = at
          lastActivityAt = at
        }
        continue
      }
      // Assistant prose advances the activity clock without being counted here (the response_item
      // assistant message is what `messageCount` counts). The envelope's `AgentMessage` item is the
      // direct successor to the `agent_message` event — and the ONLY item kind treated as activity:
      // letting `Reasoning`/`CommandExecution` advance the clock would expire an OSC-reported
      // question (see currentInputRequestedAt) while the agent is still waiting on the user.
      if (pt === 'agent_message' || (pt === 'item_completed' && itemType(payload) === 'AgentMessage')) {
        if (!Number.isNaN(at)) lastActivityAt = at
        continue
      }
      if (pt === 'task_started') {
        inTurn = true
        continue
      }
      if (pt === 'task_complete' || pt === 'turn_aborted') {
        inTurn = false
        if (!Number.isNaN(at)) {
          turnEndedAt = at
          lastActivityAt = at
        }
        continue
      }
      if (pt === 'token_count') {
        const info = asRecord(payload.info)
        if (info) {
          const total = asRecord(info.total_token_usage)
          const last = asRecord(info.last_token_usage)
          if (total) {
            outputTokens = numField(total.output_tokens)
            inputTokens = numField(total.input_tokens)
            cachedInputTokens = numField(total.cached_input_tokens)
            reasoningTokens = numField(total.reasoning_output_tokens)
          }
          if (last) contextTokens = numField(last.input_tokens)
          if (typeof info.model_context_window === 'number') {
            contextWindow = numField(info.model_context_window)
          }
        }
        continue
      }
      continue
    }

    if (obj.type === 'response_item') {
      const pt = payload.type
      if (pt === 'message' && payload.role === 'assistant') {
        const assistantText = contentText(payload.content)
        if (
          isConversationalMessage({
            role: 'assistant',
            blocks: [{ kind: 'text', text: assistantText }]
          })
        ) {
          messageCount += 1
        }
      }

      // Detect a pending request_user_input: a function_call with no matching output yet ⇒ the
      // turn is parked on the user (the "asking" state). Approval requests are intentionally not
      // persisted in rollouts; the live PTY's explicit OSC notification covers that narrow gap.
      if (pt === 'function_call' && payload.name === 'request_user_input') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
        openUserInputCalls.add(callId)
        if (!Number.isNaN(at)) lastActivityAt = at
      } else if (pt === 'function_call_output') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
        if (openUserInputCalls.delete(callId) && !Number.isNaN(at)) lastActivityAt = at
      }
      continue
    }
  }

  // Drop non-interactive (codex exec) rollouts and ones with no cwd to group on.
  if (originator != null && originator !== 'codex-tui') return null
  if (cwd == null) return null

  const title = cleanTitle(firstUser ?? '') || 'Untitled'
  const preview = toPreview(lastUser ?? firstUser ?? '')

  let turnState: 'in_progress' | 'awaiting' | 'awaiting_input' | undefined
  if (messageCount === 0) turnState = undefined
  else if (openUserInputCalls.size > 0) turnState = 'awaiting_input'
  else if (inTurn) turnState = 'in_progress'
  else turnState = 'awaiting'

  return {
    sessionId,
    agent: 'codex',
    cwd,
    title,
    preview,
    gitBranch: null, // not in the rollout (lives in Codex's threads DB); surfaced in a later phase.
    mtime,
    messageCount,
    version,
    sizeBytes,
    model,
    outputTokens,
    inputTokens,
    cachedInputTokens,
    reasoningTokens,
    contextWindow,
    contextTokens,
    firstActivityAt,
    turnState,
    turnEndedAt,
    lastActivityAt,
    threadSource: threadSource ?? undefined,
    provisional: false
  }
}

/** Parse a rollout file into a transcript. Tolerant: a read failure yields an empty transcript. */
export async function parseCodexTranscript(filePath: string): Promise<Transcript> {
  const sessionId = sessionIdFromPath(filePath)
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return { sessionId, agent: 'codex', cwd: '', title: 'Untitled', messages: [] }
  }
  return parseCodexTranscriptText(text, sessionId)
}

/** Metadata-only pass for one rollout file. Null on read failure / non-interactive / no-cwd. */
export async function extractCodexMeta(filePath: string): Promise<ConversationMeta | null> {
  const sessionId = sessionIdFromPath(filePath)
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
  return extractCodexMetaFromText(text, sessionId, mtime, sizeBytes)
}

/** Recursively list rollout `*.jsonl` files under the (date-nested) Codex sessions root. */
export async function listCodexRollouts(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(p)
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        out.push(p)
      }
    }
  }
  await walk(root)
  return out
}

/** Find a rollout file by session id (the trailing UUID in the filename). Null if not found. */
export async function resolveCodexFile(
  sessionId: string,
  root: string = defaultCodexRoot()
): Promise<string | null> {
  if (!/^[0-9a-f-]{8,}$/i.test(sessionId)) return null
  const suffix = `-${sessionId}.jsonl`
  const files = await listCodexRollouts(root)
  for (const f of files) {
    if (f.endsWith(suffix)) return f
  }
  return null
}
