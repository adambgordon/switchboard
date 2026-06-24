import { describe, it, expect } from 'vitest'
import { parseCodexTranscriptText, extractCodexMetaFromText } from '../src/main/sessions/codexParser'

const TS = '2026-06-23T14:36:56.000Z'
const TS2 = '2026-06-23T14:37:10.000Z'

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n')
}

/**
 * A representative interactive rollout: meta → task lifecycle, an injected developer + user-context
 * message (which must be skipped), the clean human prompt (event_msg/user_message), assistant text,
 * a tool call + output, the final agent_message (dup, skipped), token_count, then task_complete.
 */
function interactiveLines(opts: { originator?: string; cwd?: string } = {}): object[] {
  const { originator = 'codex-tui', cwd = '/Volumes/git/foo' } = opts
  return [
    {
      timestamp: TS,
      type: 'session_meta',
      payload: { session_id: 'abc', cwd, originator, cli_version: '0.142.0', base_instructions: { text: 'you are codex' } }
    },
    { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', model_context_window: 258400 } },
    { timestamp: TS, type: 'turn_context', payload: { turn_id: 't1', cwd, model: 'gpt-5.5' } },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions> sandbox ...' }] }
    },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/Volumes/git/foo</cwd></environment_context>' }] }
    },
    { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'add a dark mode toggle' } },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a dark mode toggle' }] }
    },
    { timestamp: TS, type: 'response_item', payload: { type: 'reasoning', content: [] } },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: "I'll add the toggle." }] }
    },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"ls"}' }
    },
    { timestamp: TS, type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'file.txt\n' } },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'm2', content: [{ type: 'output_text', text: 'Done.' }] }
    },
    { timestamp: TS, type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
    {
      timestamp: TS,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1250 },
          last_token_usage: { input_tokens: 600, cached_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 700 },
          model_context_window: 258400
        }
      }
    },
    { timestamp: TS2, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done.', completed_at: 1782225430 } }
  ]
}

describe('extractCodexMetaFromText', () => {
  it('parses an interactive session into codex meta', () => {
    const meta = extractCodexMetaFromText(jsonl(interactiveLines()), 'abc', 123, 456)
    expect(meta).not.toBeNull()
    expect(meta!.agent).toBe('codex')
    expect(meta!.cwd).toBe('/Volumes/git/foo')
    expect(meta!.title).toBe('add a dark mode toggle')
    expect(meta!.preview).toBe('add a dark mode toggle')
    expect(meta!.version).toBe('0.142.0')
    expect(meta!.model).toBe('gpt-5.5')
    expect(meta!.gitBranch).toBeNull()
    // tokens — last token_count wins; agent-native fields (never mapped onto Anthropic tiers).
    expect(meta!.outputTokens).toBe(200)
    expect(meta!.inputTokens).toBe(1000)
    expect(meta!.cachedInputTokens).toBe(400)
    expect(meta!.reasoningTokens).toBe(50)
    expect(meta!.contextWindow).toBe(258400)
    expect(meta!.contextTokens).toBe(600) // last_token_usage.input_tokens
    // user_message(1) + agent_message(1)
    expect(meta!.messageCount).toBe(2)
    // task_complete is the last boundary → awaiting
    expect(meta!.turnState).toBe('awaiting')
    expect(meta!.mtime).toBe(123)
    expect(meta!.sizeBytes).toBe(456)
  })

  it('drops non-interactive (codex exec) rollouts', () => {
    expect(extractCodexMetaFromText(jsonl(interactiveLines({ originator: 'codex_exec' })), 'abc', 1, 1)).toBeNull()
  })

  it('returns null when there is no cwd', () => {
    const lines = [{ timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }]
    expect(extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)).toBeNull()
  })

  it('reports in_progress when a task is started but not completed', () => {
    const lines = [
      { timestamp: TS, type: 'session_meta', payload: { cwd: '/x', originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }
    ]
    expect(extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)!.turnState).toBe('in_progress')
  })

  it('reports awaiting_input when parked on request_user_input', () => {
    const lines = [
      { timestamp: TS, type: 'session_meta', payload: { cwd: '/x', originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q1', arguments: '{}' } }
    ]
    expect(extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)!.turnState).toBe('awaiting_input')
  })

  it('clears awaiting_input once the user answers (matching function_call_output)', () => {
    const lines = [
      { timestamp: TS, type: 'session_meta', payload: { cwd: '/x', originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q1', arguments: '{}' } },
      { timestamp: TS, type: 'response_item', payload: { type: 'function_call_output', call_id: 'q1', output: 'yes' } }
    ]
    // No pending input, but still inside the turn (no task_complete yet) → in_progress.
    expect(extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)!.turnState).toBe('in_progress')
  })

  it('reports awaiting after a turn_aborted (interrupt)', () => {
    const lines = [
      { timestamp: TS, type: 'session_meta', payload: { cwd: '/x', originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { timestamp: TS2, type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } }
    ]
    expect(extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)!.turnState).toBe('awaiting')
  })
})

describe('parseCodexTranscriptText', () => {
  it('builds an interleaved transcript from both streams, in order', () => {
    const t = parseCodexTranscriptText(jsonl(interactiveLines()), 'abc')
    expect(t.agent).toBe('codex')
    expect(t.cwd).toBe('/Volumes/git/foo')
    expect(t.title).toBe('add a dark mode toggle')
    // human prompt → assistant text → tool_use (assistant) → tool_result (user) → assistant text
    const roles = t.messages.map((m) => `${m.role}:${m.userKind ?? ''}`)
    expect(roles).toEqual(['user:human', 'assistant:', 'assistant:', 'user:tool_result', 'assistant:'])
    // the human prompt is the CLEAN event_msg text, not the <environment_context> response_item.
    expect(t.messages[0].blocks).toEqual([{ kind: 'text', text: 'add a dark mode toggle' }])
    expect(t.messages[2].blocks[0]).toMatchObject({ kind: 'tool_use', name: 'exec_command', input: { cmd: 'ls' } })
    expect(t.messages[3].blocks[0]).toMatchObject({ kind: 'tool_result', text: 'file.txt\n', isError: false })
  })

  it('skips reasoning and injected developer/user context messages', () => {
    const t = parseCodexTranscriptText(jsonl(interactiveLines()), 'abc')
    const dump = JSON.stringify(t.messages)
    expect(dump).not.toContain('permissions instructions')
    expect(dump).not.toContain('environment_context')
  })
})
