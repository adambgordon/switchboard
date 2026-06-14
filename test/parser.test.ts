import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cleanTitle, extractMeta, extractTurnState, parseTranscript } from '../src/main/sessions/parser'
import type { TranscriptBlock } from '../src/shared/types'

/** Base for vitest temp dirs; honors CLAUDE_CODE_TMPDIR if set, else the system temp. */
const TMP_BASE = process.env.CLAUDE_CODE_TMPDIR ?? tmpdir()

const CWD = '/home/user/project-one'
const SESSION_ID = randomUUID()

/** Serialize an array of line-objects to JSONL text. */
function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

let tmpDir: string
let filePath: string

beforeAll(async () => {
  tmpDir = await mkdtemp(path.join(TMP_BASE, 'parser-test-'))
  filePath = path.join(tmpDir, `${SESSION_ID}.jsonl`)

  const lines: unknown[] = [
    // 1. User message with STRING content, wrapped in a command-message block.
    {
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      timestamp: '2026-05-29T20:00:00.000Z',
      cwd: CWD,
      gitBranch: 'develop',
      version: '2.1.156',
      message: {
        role: 'user',
        content:
          '<command-name>/refactor</command-name>\n            <command-message>refactor</command-message>\n            <command-args>the parser</command-args>'
      }
    },
    // 2. A genuine user prompt (string content) — this is the first "real" text.
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'u1',
      isSidechain: false,
      timestamp: '2026-05-29T20:00:05.000Z',
      cwd: CWD,
      gitBranch: 'develop',
      version: '2.1.156',
      message: { role: 'user', content: '  Please add a test\nwith details  ' }
    },
    // 3. Assistant message with ARRAY content: text + thinking + tool_use.
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u2',
      isSidechain: false,
      timestamp: '2026-05-29T20:00:10.000Z',
      cwd: CWD,
      gitBranch: 'develop',
      version: '2.1.156',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should run a tool', signature: 'sig' },
          { type: 'text', text: 'Running the tool now.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
        ]
      }
    },
    // 4. User message with ARRAY content carrying a tool_result (string content, error).
    {
      type: 'user',
      uuid: 'u3',
      parentUuid: 'a1',
      isSidechain: false,
      timestamp: '2026-05-29T20:00:12.000Z',
      cwd: CWD,
      gitBranch: 'develop',
      version: '2.1.156',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            is_error: true,
            content: '<tool_use_error>boom</tool_use_error>'
          }
        ]
      }
    },
    // 5. Assistant message with a tool_result-style ARRAY content part + an image block.
    {
      type: 'assistant',
      uuid: 'a2',
      parentUuid: 'u3',
      isSidechain: true,
      timestamp: '2026-05-29T20:00:15.000Z',
      cwd: CWD,
      gitBranch: 'develop',
      version: '2.1.156',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' }
            ]
          },
          { type: 'image', source: { type: 'base64' }, alt: 'a screenshot' }
        ]
      }
    },
    // 6. A malformed line (not valid JSON) — must be skipped, not throw.
    '{ this is not valid json ',
    // 7. An attachment line — must be ignored for messages.
    {
      type: 'attachment',
      uuid: 'att1',
      cwd: CWD,
      attachment: { type: 'hook_success', content: '' }
    },
    // 8. ai-title line (latest wins).
    { type: 'ai-title', aiTitle: 'Refactor the session parser', sessionId: SESSION_ID },
    // 9. last-prompt line carrying lastPrompt (used for preview).
    {
      type: 'last-prompt',
      lastPrompt: 'Now also add an indexer test, please',
      leafUuid: 'u3',
      sessionId: SESSION_ID
    }
  ]

  await writeFile(filePath, jsonl(lines), 'utf8')
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('cleanTitle', () => {
  it('strips command wrapper tags and collapses to one line', () => {
    const raw =
      '<command-name>/refactor</command-name>\n<command-message>refactor</command-message>\n<command-args>x</command-args>'
    expect(cleanTitle(raw)).toBe('')
  })

  it('strips surrounding backticks and code fences', () => {
    expect(cleanTitle('```\n`hello world`\n```')).toBe('hello world')
  })

  it('takes the first line and caps length', () => {
    const long = 'A'.repeat(200) + '\nsecond line'
    const cleaned = cleanTitle(long)
    expect(cleaned.length).toBeLessThanOrEqual(80)
    expect(cleaned).not.toContain('second line')
  })

  it('collapses internal whitespace', () => {
    expect(cleanTitle('hello     there   world')).toBe('hello there world')
  })
})

describe('parseTranscript', () => {
  it('builds ordered, normalized messages — dropping command echo, attachment, and meta lines', async () => {
    const t = await parseTranscript(filePath)

    expect(t.sessionId).toBe(SESSION_ID)
    expect(t.cwd).toBe(CWD)
    // ai-title wins the title resolution.
    expect(t.title).toBe('Refactor the session parser')

    // u1 is a slash-command echo (noise) → filtered; attachment + malformed + meta skipped.
    // Remaining: u2 (typed prompt), a1 (assistant), u3 (tool_result), a2 (assistant/sidechain).
    expect(t.messages).toHaveLength(4)
    expect(t.messages.map((m) => m.uuid)).toEqual(['u2', 'a1', 'u3', 'a2'])
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    // userKind attributes user lines; assistant messages leave it undefined.
    expect(t.messages.map((m) => m.userKind)).toEqual(['human', undefined, 'tool_result', undefined])
  })

  it('normalizes string content to a single text block', async () => {
    const t = await parseTranscript(filePath)
    const u2 = t.messages.find((m) => m.uuid === 'u2')!
    expect(u2.blocks).toEqual<TranscriptBlock[]>([
      { kind: 'text', text: '  Please add a test\nwith details  ' }
    ])
    expect(u2.timestamp).toBe('2026-05-29T20:00:05.000Z')
    expect(u2.isSidechain).toBe(false)
    expect(u2.userKind).toBe('human')
  })

  it('drops thinking blocks, keeping text and tool_use', async () => {
    const t = await parseTranscript(filePath)
    const a1 = t.messages.find((m) => m.uuid === 'a1')!
    // The thinking block is gone; only the text + tool_use survive.
    expect(a1.blocks).toEqual<TranscriptBlock[]>([
      { kind: 'text', text: 'Running the tool now.' },
      { kind: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }
    ])
  })

  it('normalizes a string tool_result with is_error (attributed tool_result, not "You")', async () => {
    const t = await parseTranscript(filePath)
    const u3 = t.messages.find((m) => m.uuid === 'u3')!
    expect(u3.userKind).toBe('tool_result')
    expect(u3.blocks).toEqual<TranscriptBlock[]>([
      {
        kind: 'tool_result',
        toolUseId: 'toolu_1',
        text: '<tool_use_error>boom</tool_use_error>',
        isError: true
      }
    ])
  })

  it('joins array tool_result content to a string and maps image blocks; flags sidechain', async () => {
    const t = await parseTranscript(filePath)
    const a2 = t.messages.find((m) => m.uuid === 'a2')!
    expect(a2.isSidechain).toBe(true)
    expect(a2.blocks).toEqual<TranscriptBlock[]>([
      { kind: 'tool_result', toolUseId: 'toolu_2', text: 'line one\nline two', isError: false },
      { kind: 'image', alt: 'a screenshot' }
    ])
  })

  it('filters non-conversational user lines (command echo, isMeta caveat, task-notification)', async () => {
    const file = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      file,
      jsonl([
        { type: 'user', uuid: 'p', isSidechain: false, cwd: CWD, message: { role: 'user', content: 'real prompt' } },
        { type: 'user', uuid: 'c', isSidechain: false, cwd: CWD, message: { role: 'user', content: '<command-name>/help</command-name>' } },
        { type: 'user', uuid: 'm', isMeta: true, isSidechain: false, cwd: CWD, message: { role: 'user', content: '<system-reminder>note</system-reminder>' } },
        { type: 'user', uuid: 'n', isSidechain: false, cwd: CWD, message: { role: 'user', content: '<task-notification>\n<task-id>x</task-id>\n</task-notification>' } }
      ]),
      'utf8'
    )
    const t = await parseTranscript(file)
    // Only the genuine typed prompt survives.
    expect(t.messages.map((m) => m.uuid)).toEqual(['p'])
    expect(t.messages[0].userKind).toBe('human')
  })

  it('keeps the interrupt sentinel as an `interrupted` note', async () => {
    const file = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      file,
      jsonl([
        { type: 'user', uuid: 'p', isSidechain: false, cwd: CWD, message: { role: 'user', content: 'go' } },
        {
          type: 'assistant',
          uuid: 'a',
          isSidechain: false,
          cwd: CWD,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]
          }
        },
        {
          type: 'user',
          uuid: 'i',
          isSidechain: false,
          cwd: CWD,
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
        }
      ]),
      'utf8'
    )
    const t = await parseTranscript(file)
    expect(t.messages.find((m) => m.uuid === 'i')!.userKind).toBe('interrupted')
  })

  it('drops an assistant message whose only block was thinking', async () => {
    const file = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      file,
      jsonl([
        { type: 'user', uuid: 'p', isSidechain: false, cwd: CWD, message: { role: 'user', content: 'hi' } },
        {
          type: 'assistant',
          uuid: 'tonly',
          isSidechain: false,
          cwd: CWD,
          message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }] }
        },
        {
          type: 'assistant',
          uuid: 'a',
          isSidechain: false,
          cwd: CWD,
          message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
        }
      ]),
      'utf8'
    )
    const t = await parseTranscript(file)
    // The thinking-only message yields no blocks → dropped; the real answer remains.
    expect(t.messages.map((m) => m.uuid)).toEqual(['p', 'a'])
  })

  it('returns an empty transcript for a non-existent file (no throw)', async () => {
    const t = await parseTranscript(path.join(tmpDir, 'does-not-exist.jsonl'))
    expect(t.messages).toEqual([])
    expect(t.cwd).toBe('')
    expect(t.title).toBe('Untitled')
  })
})

describe('extractMeta', () => {
  it('produces correct metadata, skipping malformed/meta lines', async () => {
    const meta = await extractMeta(filePath)
    expect(meta).not.toBeNull()
    const m = meta!

    expect(m.sessionId).toBe(SESSION_ID)
    expect(m.cwd).toBe(CWD)
    expect(m.title).toBe('Refactor the session parser')
    // last-prompt drives the preview.
    expect(m.preview).toBe('Now also add an indexer test, please')
    expect(m.gitBranch).toBe('develop')
    expect(m.version).toBe('2.1.156')
    // 5 user/assistant lines counted; attachment/ai-title/last-prompt/malformed excluded.
    expect(m.messageCount).toBe(5)
    expect(m.provisional).toBe(false)
    expect(typeof m.mtime).toBe('number')
    expect(m.mtime).toBeGreaterThan(0)
  })

  it('falls back to first user text for preview when no last-prompt is present', async () => {
    const file = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      file,
      jsonl([
        {
          type: 'user',
          uuid: 'x1',
          isSidechain: false,
          timestamp: '2026-05-29T21:00:00.000Z',
          cwd: CWD,
          message: { role: 'user', content: '   first   real    prompt   here   ' }
        }
      ]),
      'utf8'
    )
    const meta = await extractMeta(file)
    expect(meta).not.toBeNull()
    // Title falls through aiTitle/summary to the cleaned first user text.
    expect(meta!.title).toBe('first real prompt here')
    // Preview is whitespace-collapsed first user text.
    expect(meta!.preview).toBe('first real prompt here')
  })

  it('returns null when the file has no cwd anywhere', async () => {
    const file = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      file,
      jsonl([
        { type: 'mode', mode: 'normal', sessionId: 'x' },
        { type: 'user', uuid: 'n1', message: { role: 'user', content: 'no cwd here' } }
      ]),
      'utf8'
    )
    const meta = await extractMeta(file)
    expect(meta).toBeNull()
  })

  it('returns null for a non-existent file', async () => {
    const meta = await extractMeta(path.join(tmpDir, 'nope.jsonl'))
    expect(meta).toBeNull()
  })

  it('prefers summary over first user text when no aiTitle is present', async () => {
    const file = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      file,
      jsonl([
        { type: 'summary', summary: 'A concise session summary' },
        {
          type: 'user',
          uuid: 's1',
          cwd: CWD,
          message: { role: 'user', content: 'the actual first prompt' }
        }
      ]),
      'utf8'
    )
    const meta = await extractMeta(file)
    expect(meta!.title).toBe('A concise session summary')
  })

  it('surfaces turnState/turnEndedAt/lastActivityAt from the transcript tail (sidechain ignored)', async () => {
    const meta = await extractMeta(filePath)
    // The shared fixture's last MAIN-chain line is u3 (a user tool_result, ts …12.000Z);
    // a2 is a sidechain, so the turn reads as in-progress and lastActivityAt is u3's time.
    expect(meta!.turnState).toBe('in_progress')
    expect(meta!.turnEndedAt).toBeNull()
    expect(meta!.lastActivityAt).toBe(Date.parse('2026-05-29T20:00:12.000Z'))
  })
})

describe('extractTurnState', () => {
  const T1 = '2026-06-01T17:00:00.000Z'
  const T2 = '2026-06-01T17:00:30.000Z'

  it('awaiting when the last main line is an assistant end_turn', () => {
    const r = extractTurnState(
      jsonl([
        { type: 'user', isSidechain: false, timestamp: T1, message: { role: 'user', content: 'hi' } },
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T2,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting')
    expect(r.turnEndedAt).toBe(Date.parse(T2))
    expect(r.lastActivityAt).toBe(Date.parse(T2))
  })

  it('awaiting via a trailing turn_duration, ignoring metadata trailers after it', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
        },
        { type: 'system', subtype: 'turn_duration', isSidechain: false, timestamp: T2 },
        { type: 'ai-title', aiTitle: 'Some title' },
        { type: 'mode', mode: 'normal' },
        { type: 'permission-mode', permissionMode: 'default' }
      ])
    )
    expect(r.turnState).toBe('awaiting')
    // turn_duration is later than the assistant message — prefer it.
    expect(r.turnEndedAt).toBe(Date.parse(T2))
  })

  it('in_progress when the last main line is a dangling tool_use', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]
          }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
    expect(r.turnEndedAt).toBeNull()
  })

  it('awaiting_input when the last main line is an AskUserQuestion tool_use', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: {} }]
          }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting_input')
    expect(r.awaitingTool).toBe('AskUserQuestion')
    expect(r.turnEndedAt).toBeNull()
    expect(r.lastActivityAt).toBe(Date.parse(T1))
  })

  it('awaiting_input when the last main line is an ExitPlanMode tool_use', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_p', name: 'ExitPlanMode', input: {} }]
          }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting_input')
    expect(r.awaitingTool).toBe('ExitPlanMode')
    expect(r.turnEndedAt).toBeNull()
  })

  it('flips back to in_progress once the blocking tool is answered (user tool_result follows)', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: {} }]
          }
        },
        {
          type: 'user',
          isSidechain: false,
          timestamp: T2,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'Option A' }]
          }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
    expect(r.awaitingTool).toBeUndefined()
  })

  it('ignores a sidechain AskUserQuestion (sub-agent) when resolving the main turn', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'task', name: 'Agent', input: {} }]
          }
        },
        // a sub-agent asking its own question — must NOT park the PARENT on awaiting_input
        {
          type: 'assistant',
          isSidechain: true,
          timestamp: T2,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'sub_q', name: 'AskUserQuestion', input: {} }]
          }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
    expect(r.awaitingTool).toBeUndefined()
  })

  it('in_progress when the last main line is a user tool_result', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]
          }
        },
        {
          type: 'user',
          isSidechain: false,
          timestamp: T2,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
  })

  it('ignores a sidechain turn-end (sub-agent) when resolving the main turn', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'task', name: 'Agent', input: {} }]
          }
        },
        // a sub-agent finishing — must NOT mark the parent turn as awaiting
        {
          type: 'assistant',
          isSidechain: true,
          timestamp: T2,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'subagent done' }] }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
    expect(r.turnEndedAt).toBeNull()
    // sidechain (T2) is excluded, so lastActivityAt is the MAIN assistant message (T1).
    expect(r.lastActivityAt).toBe(Date.parse(T1))
  })

  it('treats a streaming/incomplete assistant message (no stop_reason) as in_progress', () => {
    // Claude writes assistant lines as fragments; a partial one has no stop_reason yet.
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'partial…' }] }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
    expect(r.turnEndedAt).toBeNull()
    expect(r.lastActivityAt).toBe(Date.parse(T1))
  })

  it('treats a terminal stop_reason like max_tokens as awaiting', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'cut off' }] }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting')
    expect(r.turnEndedAt).toBe(Date.parse(T1))
  })

  it('treats pause_turn as in_progress (more is coming)', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: 'pause_turn', content: [{ type: 'text', text: '…' }] }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
  })

  it('returns undefined turnState for a transcript with no messages', () => {
    const r = extractTurnState(jsonl([{ type: 'summary', summary: 'x' }, { type: 'mode', mode: 'normal' }]))
    expect(r.turnState).toBeUndefined()
    expect(r.turnEndedAt).toBeNull()
    expect(r.lastActivityAt).toBeNull()
  })

  // --- non-conversational trailing user lines must NOT read as in_progress (Issue 1) ---

  it('stays awaiting when a finished turn is followed by /model command output', () => {
    // Running `/model` after an end_turn appends user lines (caveat + command + stdout) that are
    // NOT a turn. The dot must stay awaiting, not flip to working.
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Approve this?' }] }
        },
        {
          type: 'user',
          isMeta: true,
          isSidechain: false,
          timestamp: T2,
          message: { role: 'user', content: '<local-command-caveat>Caveat: DO NOT respond to these messages</local-command-caveat>' }
        },
        {
          type: 'user',
          isSidechain: false,
          timestamp: T2,
          message: {
            role: 'user',
            content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>'
          }
        },
        {
          type: 'user',
          isSidechain: false,
          timestamp: T2,
          message: { role: 'user', content: '<local-command-stdout>Set model to Opus 4.8 (1M context)</local-command-stdout>' }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting')
    expect(r.turnEndedAt).toBe(Date.parse(T1))
    // lastActivityAt reflects the real assistant message, not the /model echo.
    expect(r.lastActivityAt).toBe(Date.parse(T1))
  })

  it('stays awaiting when a finished turn is followed by ! bash command output', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'pushed' }] }
        },
        {
          type: 'user',
          isSidechain: false,
          timestamp: T2,
          message: { role: 'user', content: '<bash-input>git push</bash-input><bash-stdout>develop -> develop</bash-stdout>' }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting')
  })

  it('stays awaiting when a finished turn is followed by a background task-notification', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'started a task' }] }
        },
        {
          type: 'user',
          isSidechain: false,
          timestamp: T2,
          message: { role: 'user', content: '<task-notification>\n<task-id>abc</task-id>\n</task-notification>' }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting')
  })

  it('treats an interrupt sentinel as awaiting, aborting a dangling tool_use (closes the interrupted-reads-as-working gap)', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }]
          }
        },
        {
          type: 'user',
          isSidechain: false,
          timestamp: T2,
          message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
        }
      ])
    )
    expect(r.turnState).toBe('awaiting')
    expect(r.turnEndedAt).toBe(Date.parse(T2))
  })

  it('still in_progress for a real typed prompt after a finished turn', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'assistant',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }
        },
        { type: 'user', isSidechain: false, timestamp: T2, message: { role: 'user', content: 'now do the next thing' } }
      ])
    )
    expect(r.turnState).toBe('in_progress')
    expect(r.lastActivityAt).toBe(Date.parse(T2))
  })

  it('a real prompt that merely mentions a wrapper tag mid-text is still in_progress', () => {
    // Anchored match: a tag must START the content to be noise; a prompt discussing one is real.
    const r = extractTurnState(
      jsonl([
        {
          type: 'user',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'user', content: 'why does <local-command-stdout> show up in the transcript?' }
        }
      ])
    )
    expect(r.turnState).toBe('in_progress')
  })

  it('undefined when the only user line is a slash command (no real turn yet)', () => {
    const r = extractTurnState(
      jsonl([
        {
          type: 'user',
          isSidechain: false,
          timestamp: T1,
          message: { role: 'user', content: '<command-name>/help</command-name>' }
        }
      ])
    )
    expect(r.turnState).toBeUndefined()
  })
})

describe('extractMeta — size / model / tokens / first-activity', () => {
  it('captures model, sums token usage by tier + context, sizes the file, stamps first activity', async () => {
    const fp = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      fp,
      jsonl([
        {
          type: 'user',
          uuid: 'u1',
          isSidechain: false,
          timestamp: '2026-06-12T10:00:00.000Z',
          cwd: CWD,
          message: { role: 'user', content: 'hello' }
        },
        {
          type: 'assistant',
          uuid: 'a1',
          isSidechain: false,
          timestamp: '2026-06-12T10:01:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }
          }
        },
        {
          type: 'assistant',
          uuid: 'a2',
          isSidechain: false,
          timestamp: '2026-06-12T11:30:00.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'more' }],
            usage: { input_tokens: 2, cache_read_input_tokens: 2000, output_tokens: 8 }
          }
        }
      ])
    )
    const m = await extractMeta(fp)
    expect(m?.model).toBe('claude-opus-4-8')
    expect(m?.outputTokens).toBe(13) // 5 + 8
    expect(m?.inputTokens).toBe(3112) // (10+100+1000) + (2+0+2000)
    expect(m?.inputBaseTokens).toBe(12) // 10 + 2
    expect(m?.cacheWriteTokens).toBe(100) // 100 + 0
    expect(m?.cacheReadTokens).toBe(3000) // 1000 + 2000
    expect(m?.contextTokens).toBe(2002) // last main-chain turn: 2 + 0 + 2000
    expect(m?.sizeBytes).toBeGreaterThan(0)
    expect(m?.firstActivityAt).toBe(Date.parse('2026-06-12T10:00:00.000Z'))
  })

  it('dedups repeated usage by message id; sidechain turns count but do not set context', async () => {
    const fp = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      fp,
      jsonl([
        { type: 'user', uuid: 'u1', isSidechain: false, timestamp: '2026-06-12T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'hi' } },
        // msg_A written across two lines (one per content block) — identical usage, must count ONCE.
        {
          type: 'assistant',
          uuid: 'a1',
          isSidechain: false,
          timestamp: '2026-06-12T10:01:00.000Z',
          message: {
            role: 'assistant',
            id: 'msg_A',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'one' }],
            usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }
          }
        },
        {
          type: 'assistant',
          uuid: 'a1b',
          isSidechain: false,
          timestamp: '2026-06-12T10:01:00.000Z',
          message: {
            role: 'assistant',
            id: 'msg_A',
            model: 'claude-opus-4-8',
            content: [{ type: 'tool_use', id: 't', name: 'X', input: {} }],
            usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 }
          }
        },
        // msg_B — the last MAIN-chain turn; defines context.
        {
          type: 'assistant',
          uuid: 'a2',
          isSidechain: false,
          timestamp: '2026-06-12T10:02:00.000Z',
          message: {
            role: 'assistant',
            id: 'msg_B',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'two' }],
            usage: { input_tokens: 2, cache_read_input_tokens: 2000, output_tokens: 8 }
          }
        },
        // msg_S — a sub-agent (sidechain) turn: real cost (counts), but never the main context window.
        {
          type: 'assistant',
          uuid: 's1',
          isSidechain: true,
          timestamp: '2026-06-12T10:03:00.000Z',
          message: {
            role: 'assistant',
            id: 'msg_S',
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'sub' }],
            usage: { input_tokens: 7, cache_read_input_tokens: 70, output_tokens: 3 }
          }
        }
      ])
    )
    const m = await extractMeta(fp)
    expect(m?.outputTokens).toBe(16) // 5 (msg_A once) + 8 + 3
    expect(m?.inputBaseTokens).toBe(19) // 10 + 2 + 7
    expect(m?.cacheWriteTokens).toBe(100) // 100 (msg_A once) + 0 + 0
    expect(m?.cacheReadTokens).toBe(3070) // 1000 + 2000 + 70
    expect(m?.inputTokens).toBe(3189) // 19 + 100 + 3070
    expect(m?.contextTokens).toBe(2002) // msg_B (last main chain): 2 + 0 + 2000 — sidechain ignored
  })

  it('ignores the <synthetic> model and tolerates missing usage (zeros)', async () => {
    const fp = path.join(tmpDir, `${randomUUID()}.jsonl`)
    await writeFile(
      fp,
      jsonl([
        { type: 'user', uuid: 'u1', isSidechain: false, timestamp: '2026-06-12T10:00:00.000Z', cwd: CWD, message: { role: 'user', content: 'hi' } },
        {
          type: 'assistant',
          uuid: 'a1',
          isSidechain: false,
          timestamp: '2026-06-12T10:00:01.000Z',
          message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'x' }] }
        }
      ])
    )
    const m = await extractMeta(fp)
    expect(m?.model).toBeNull()
    expect(m?.outputTokens).toBe(0)
    expect(m?.inputTokens).toBe(0)
  })
})
