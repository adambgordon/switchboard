/** Pi 0.84.3 JSONL: render the current leaf's ancestry, never concatenate alternate branches. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ConversationMeta, Transcript, TranscriptBlock, TranscriptMessage } from '../../shared/types'
import { countConversationalMessages } from '../../shared/messageCount'

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
const time = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Date.parse(string(value))
  return Number.isFinite(parsed) ? parsed : null
}

export function defaultPiRoot(): string {
  return path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent'), 'sessions')
}

function readSession(text: string): { header: Json; entries: Json[]; active: Json[] } {
  const rows: Json[] = []
  for (const line of text.split('\n')) {
    try {
      const row = object(JSON.parse(line))
      if (typeof row.type === 'string') rows.push(row)
    } catch { /* incomplete writes and malformed lines are skipped */ }
  }
  const header = rows[0] ?? {}
  if (header.type !== 'session' || !string(header.id) || !string(header.cwd)) {
    throw new Error('Invalid Pi session header')
  }
  const entries = rows.slice(1).filter((row) => typeof row.id === 'string')
  const byId = new Map(entries.map((entry) => [string(entry.id), entry]))
  const active: Json[] = []
  const seen = new Set<string>()
  let entry: Json | undefined = entries.at(-1)
  while (entry && !seen.has(string(entry.id))) {
    seen.add(string(entry.id))
    active.push(entry)
    entry = byId.get(string(entry.parentId))
  }
  return { header, entries, active: active.reverse() }
}

function blocks(content: unknown): TranscriptBlock[] {
  if (typeof content === 'string') return content ? [{ kind: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const result: TranscriptBlock[] = []
  for (const value of content) {
    const block = object(value)
    if (block.type === 'text' && typeof block.text === 'string') result.push({ kind: 'text', text: block.text })
    if (block.type === 'image') result.push({ kind: 'image', alt: 'Attached image' })
    if (block.type === 'toolCall') result.push({
      kind: 'tool_use', id: string(block.id), name: string(block.name), input: block.arguments ?? {}
    })
  }
  return result
}

function messagesFor(entries: Json[]): TranscriptMessage[] {
  const messages: TranscriptMessage[] = []
  for (const entry of entries) {
    if (entry.type !== 'message') continue
    const message = object(entry.message)
    if (!['user', 'assistant', 'toolResult'].includes(string(message.role))) continue
    let content = blocks(message.content)
    if (message.role === 'toolResult') {
      content = [{
        kind: 'tool_result', toolUseId: string(message.toolCallId),
        text: content.map((block) => block.kind === 'text' ? block.text : block.kind === 'image' ? '[Image]' : '').join('\n'),
        isError: message.isError === true
      }]
    }
    if (!content.length) continue
    const timestamp = time(message.timestamp) ?? time(entry.timestamp)
    messages.push({
      uuid: string(entry.id), role: message.role === 'assistant' ? 'assistant' : 'user',
      ...(message.role === 'user' ? { userKind: 'human' as const } :
        message.role === 'toolResult' ? { userKind: 'tool_result' as const } : {}),
      blocks: content, isSidechain: false, timestamp: timestamp === null ? null : new Date(timestamp).toISOString()
    })
  }
  return messages
}

function userText(message: TranscriptMessage): string {
  return message.blocks.map((block) => block.kind === 'text' ? block.text : '').join('\n')
}

function titleFor(entries: Json[], messages: TranscriptMessage[]): string {
  const info = entries.filter((entry) => entry.type === 'session_info').at(-1)
  const custom = string(info?.name).trim()
  const first = messages.find((message) => message.userKind === 'human')
  return custom || (first ? userText(first).trim().split('\n')[0].slice(0, 120) : '') || 'Untitled'
}

export function parsePiTranscriptText(text: string): Transcript {
  const { header, entries, active } = readSession(text)
  const messages = messagesFor(active)
  return { sessionId: string(header.id), agent: 'pi', cwd: string(header.cwd), title: titleFor(entries, messages), messages }
}

export function extractPiMetaFromText(text: string, mtime: number, sizeBytes: number): ConversationMeta | null {
  let session: ReturnType<typeof readSession>
  try { session = readSession(text) } catch { return null }
  const { header, entries, active } = session
  const messages = messagesFor(active)
  let model: string | null = null
  let inputTokens = 0
  let inputBaseTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let contextTokens = 0
  let firstActivityAt: number | null = null
  let lastActivityAt: number | null = null
  let turnState: ConversationMeta['turnState']
  let turnEndedAt: number | null = null
  for (const entry of active) {
    if (entry.type === 'model_change') model = string(entry.modelId) || model
    if (entry.type !== 'message') continue
    const message = object(entry.message)
    if (message.role === 'user' || message.role === 'assistant') {
      const at = time(message.timestamp) ?? time(entry.timestamp)
      if (at !== null) {
        firstActivityAt = firstActivityAt === null ? at : Math.min(firstActivityAt, at)
        lastActivityAt = lastActivityAt === null ? at : Math.max(lastActivityAt, at)
      }
    }
    if (message.role === 'assistant') {
      model = string(message.model) || model
      const usage = object(message.usage)
      const base = number(usage.input)
      const read = number(usage.cacheRead)
      const write = number(usage.cacheWrite)
      const output = number(usage.output)
      inputBaseTokens += base
      inputTokens += base + read + write
      outputTokens += output
      cacheReadTokens += read
      cacheWriteTokens += write
      if (Object.keys(usage).length) contextTokens = base + read + write + output
      turnState = message.stopReason === 'toolUse' ? 'in_progress' : 'awaiting'
      turnEndedAt = turnState === 'awaiting' ? time(message.timestamp) ?? time(entry.timestamp) : null
    } else if (message.role === 'user' || message.role === 'toolResult') {
      turnState = 'in_progress'
      turnEndedAt = null
    }
  }
  const lastUser = messages.filter((message) => message.userKind === 'human').at(-1)
  return {
    sessionId: string(header.id), agent: 'pi', cwd: string(header.cwd), title: titleFor(entries, messages),
    preview: lastUser ? userText(lastUser).replace(/\s+/g, ' ').trim().slice(0, 200) : '',
    gitBranch: null, mtime, sizeBytes, version: null, model,
    messageCount: countConversationalMessages(messages), inputTokens, inputBaseTokens, outputTokens,
    cacheReadTokens, cacheWriteTokens, contextTokens, firstActivityAt, lastActivityAt, turnState, turnEndedAt
  }
}

export async function parsePiTranscript(filePath: string): Promise<Transcript> {
  return parsePiTranscriptText(await readFile(filePath, 'utf8'))
}

export async function extractPiMeta(filePath: string): Promise<ConversationMeta | null> {
  try {
    const [text, stats] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)])
    return extractPiMetaFromText(text, stats.mtimeMs, stats.size)
  } catch { return null }
}

export async function listPiSessions(root = defaultPiRoot()): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(file)
    }
  }
  await walk(root)
  return out
}

export async function resolvePiFile(sessionId: string, root = defaultPiRoot()): Promise<string | null> {
  // Validate against the header: --session also supports explicitly named files, so filenames alone
  // are not an identity. Only inspect Pi's own session root, never a renderer-supplied path.
  for (const file of await listPiSessions(root)) {
    const meta = await extractPiMeta(file)
    if (meta?.sessionId === sessionId) return file
  }
  return null
}
