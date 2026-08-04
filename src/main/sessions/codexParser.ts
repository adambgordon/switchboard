/**
 * Read-only parsing of Codex session rollouts
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`).
 *
 * Each line is `{ timestamp, type, payload }`. Two streams matter:
 *   - `response_item` — the canonical model thread (OpenAI Responses API items): assistant/user
 *     `message`s, `reasoning` (dropped, like Claude "thinking"), `function_call` /
 *     `function_call_output`, `custom_tool_call` / `custom_tool_call_output`, `web_search_call`.
 *   - `event_msg` — the TUI event stream: `user_message` (the clean human prompt), `agent_message`
 *     (assistant final text — redundant with the response_item assistant message, so dropped from
 *     the transcript), `token_count`, and `task_started`/`task_complete`/`turn_aborted`
 *     (explicit turn boundaries).
 *
 * The transcript walks lines in order and emits: human turns from `event_msg/user_message` (the
 * de-noised prompt — the response_item user messages carry injected <environment_context>/AGENTS.md
 * blocks, so they're skipped), assistant text from response_item assistant messages, and tool
 * calls/results from function_call(+custom/web)/function_call_output. These map onto the same
 * normalized tool_use/tool_result block shapes as the Claude parser, so the renderer is shared.
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

  for (const line of splitLines(text)) {
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
      if (payload.type === 'user_message') {
        const msgText = typeof payload.message === 'string' ? payload.message : ''
        if (msgText.trim().length === 0) continue
        if (firstUser == null) firstUser = msgText
        add('user', [{ kind: 'text', text: msgText }], ts, 'human')
      }
      // agent_message duplicates the response_item assistant text; token_count / task_* are not
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

  for (const line of splitLines(text)) {
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
      if (pt === 'user_message') {
        const m = typeof payload.message === 'string' ? payload.message : ''
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
        }
        continue
      }
      if (pt === 'agent_message') {
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

/** An unbound, freshly-spawned new-Codex PTY awaiting correlation to its rollout. */
export interface ProvisionalCodexPty {
  ptyId: string
  cwd: string
  /**
   * ms epochs of every submit (Enter) the user has made in this PTY, oldest first. Empty when they
   * have submitted nothing, in which case this PTY can own no rollout. Deliberately NOT the spawn
   * time — see matchProvisionalCodex.
   *
   * Several are kept because a submit does not always produce a turn: Enter on an empty composer
   * writes nothing, and neither does one typed while Codex is still launching. Keeping only the
   * first would anchor the PTY to a keystroke that produced nothing, so its real rollout would never
   * look close enough to match.
   */
  submitAts: number[]
}

/** A just-indexed Codex conversation a provisional PTY might bind to. */
export interface CodexBindCandidate {
  sessionId: string
  cwd: string
  /** ms epoch of the rollout's first message; null when it has none yet. */
  firstActivityAt: number | null
}

/** How far BEFORE a submit a rollout's first activity may sit and still be that submit's. Covers
 *  clock/ordering jitter only — a rollout can't really precede the keystroke that created it. */
const BIND_SKEW_MS = 2000

/** How far AFTER a submit a rollout's first activity may sit and still be that submit's. Codex
 *  timestamps `user_message` when it PROCESSES the submit, so the true gap is milliseconds; this is a
 *  generous backstop for a loaded machine, not a typical value. It must stay finite: an unbounded
 *  upper edge is what let a PTY whose Enter produced no turn reach forward and claim a rollout some
 *  other terminal created much later. */
const BIND_MAX_LAG_MS = 30_000

/**
 * Correlate unbound provisional new-Codex PTYs to their freshly-indexed rollouts. A new Codex rollout
 * only hits disk at its FIRST turn (verified: the file's birthtime is the first-turn time, ~tens of
 * seconds after the session logically starts), so a time-boxed file poll from spawn can't catch it —
 * instead we bind when the rollout is indexed (which the live-turn re-index already does the moment
 * the session goes active).
 *
 * The correlation key is a PTY's SUBMIT, not its spawn time, because that keystroke is what CREATES
 * the rollout — spawn time has no causal link to it. Keying on spawn produced two real mispairings,
 * both of which put a row's terminal on a different conversation than its transcript: an idle tab
 * stealing a typed tab's rollout (a never-typed-in PTY still passed the gate, and being older it was
 * served first), and two tabs typed in the opposite order to their spawn swapping outright.
 *
 * Matching is by PROXIMITY, not by order. Serving PTYs in submit order and handing each the earliest
 * rollout that merely came *after* its submit reproduced the same class of theft one step in: a PTY
 * whose Enter produced no turn at all (an empty composer, or one typed while Codex was still
 * launching) still competed, and being earliest it won — permanently, since a bound id then sits in
 * `liveIds`. So instead every (submit, rollout) pair inside a BOUNDED window becomes a candidate
 * pairing, the closest pairings are taken first, and each PTY and each rollout is used at most once.
 * A stray keystroke can no longer outrank the terminal that actually produced the rollout, because
 * that terminal's submit sits nearer to it. Same cwd is still required, and ids already driven by a
 * live PTY are still excluded.
 *
 * This is a heuristic, not an identity: Codex mints its own id, offers no flag to impose one, and
 * records no pid, so timing is the only signal available in-process. Ambiguity therefore fails
 * CLOSED — an unbound PTY is a terminal that works but isn't linked to its row, a far smaller harm
 * than a row wired to someone else's conversation. Pure — returns the (ptyId, sessionId) pairs to
 * bind, ordered by submit time.
 */
export function matchProvisionalCodex(
  provisional: ProvisionalCodexPty[],
  candidates: CodexBindCandidate[],
  liveIds: ReadonlySet<string>,
  skewMs: number = BIND_SKEW_MS,
  maxLagMs: number = BIND_MAX_LAG_MS
): { ptyId: string; sessionId: string }[] {
  interface Pairing {
    ptyId: string
    sessionId: string
    /** |rollout activity − submit|; smaller is a better explanation of who created the rollout. */
    distance: number
    submitAt: number
  }

  const pairings: Pairing[] = []
  for (const pty of provisional) {
    for (const c of candidates) {
      if (c.cwd !== pty.cwd) continue
      if (c.firstActivityAt == null) continue
      if (liveIds.has(c.sessionId)) continue
      for (const submitAt of pty.submitAts) {
        const lag = c.firstActivityAt - submitAt
        if (lag < -skewMs || lag > maxLagMs) continue
        pairings.push({ ptyId: pty.ptyId, sessionId: c.sessionId, distance: Math.abs(lag), submitAt })
      }
    }
  }

  // Closest first, with deterministic tie-breaks so the result never depends on input order.
  pairings.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.submitAt - b.submitAt ||
      (a.ptyId === b.ptyId ? 0 : a.ptyId < b.ptyId ? -1 : 1)
  )

  const takenPtys = new Set<string>()
  const takenSessions = new Set<string>()
  const chosen: Pairing[] = []
  for (const p of pairings) {
    if (takenPtys.has(p.ptyId) || takenSessions.has(p.sessionId)) continue
    takenPtys.add(p.ptyId)
    takenSessions.add(p.sessionId)
    chosen.push(p)
  }

  chosen.sort((a, b) => a.submitAt - b.submitAt)
  return chosen.map(({ ptyId, sessionId }) => ({ ptyId, sessionId }))
}
