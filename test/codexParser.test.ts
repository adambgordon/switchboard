import { describe, it, expect } from 'vitest'
import { parseCodexTranscriptText, extractCodexMetaFromText } from '../src/main/sessions/codexParser'
import { countConversationalMessages } from '../src/shared/messageCount'

const TS = '2026-06-23T14:36:56.000Z'
const TS2 = '2026-06-23T14:37:10.000Z'
const TS3 = '2026-06-23T14:37:20.000Z'

/** An `event_msg/item_completed` line wrapping one item of the unified envelope. */
function itemLine(timestamp: string, item: object): object {
  return { timestamp, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'abc', turn_id: 't1', item } }
}

function jsonl(lines: object[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n')
}

/**
 * A representative interactive rollout: meta → task lifecycle, an injected developer + user-context
 * message (which must be skipped), the clean human prompt (event_msg/user_message), assistant text,
 * a tool call + output, the final agent_message (dup, skipped), token_count, then task_complete.
 */
function interactiveLines(
  opts: { originator?: string; cwd?: string; threadSource?: string } = {}
): object[] {
  const { originator = 'codex-tui', cwd = '/Users/dev/foo', threadSource } = opts
  return [
    {
      timestamp: TS,
      type: 'session_meta',
      payload: {
        session_id: 'abc',
        cwd,
        originator,
        thread_source: threadSource,
        cli_version: '0.142.0',
        base_instructions: { text: 'you are codex' }
      }
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
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/Users/dev/foo</cwd></environment_context>' }] }
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

/**
 * The same session in the LATER rollout shape: the per-kind `user_message` / `agent_message` events
 * are gone, and their content arrives through the unified `event_msg/item_completed` envelope. The
 * `response_item` stream is unchanged, so the assistant text and tool plumbing still come from
 * there — which is exactly why every non-`UserMessage` item must be ignored.
 */
function itemStreamLines(opts: { cwd?: string; userItem?: object } = {}): object[] {
  const { cwd = '/Users/dev/foo', userItem } = opts
  return [
    {
      timestamp: TS,
      type: 'session_meta',
      payload: { session_id: 'abc', cwd, originator: 'codex-tui', cli_version: '0.147.0' }
    },
    { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: TS, type: 'turn_context', payload: { turn_id: 't1', cwd, model: 'gpt-5.6' } },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions> sandbox ...' }] }
    },
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/Users/dev/foo</cwd></environment_context>' }] }
    },
    // The clean prompt is ALSO mirrored here; it stays skipped so the envelope is the only source.
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a dark mode toggle' }] }
    },
    itemLine(TS, userItem ?? { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'add a dark mode toggle', text_elements: [] }] }),
    { timestamp: TS, type: 'response_item', payload: { type: 'reasoning', content: [] } },
    itemLine(TS, { type: 'Reasoning', id: 'rs1', summary_text: [], raw_content: [] }),
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: "I'll add the toggle." }] }
    },
    itemLine(TS, { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: "I'll add the toggle." }], phase: 'commentary' }),
    {
      timestamp: TS,
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_1', input: 'const r = await tools.exec_command({cmd:"ls"})' }
    },
    { timestamp: TS, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1', output: 'file.txt\n' } },
    itemLine(TS2, { type: 'CommandExecution', id: 'exec1', command: 'ls', exit_code: 0 }),
    {
      timestamp: TS2,
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'm2', content: [{ type: 'output_text', text: 'Done.' }] }
    },
    itemLine(TS2, { type: 'AgentMessage', id: 'm2', content: [{ type: 'Text', text: 'Done.' }], phase: 'final_answer' }),
    {
      timestamp: TS2,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50 },
          last_token_usage: { input_tokens: 600 },
          model_context_window: 258400
        }
      }
    },
    { timestamp: TS3, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done.' } }
  ]
}

describe('extractCodexMetaFromText', () => {
  it('parses an interactive session into codex meta', () => {
    const meta = extractCodexMetaFromText(jsonl(interactiveLines()), 'abc', 123, 456)
    expect(meta).not.toBeNull()
    expect(meta!.agent).toBe('codex')
    expect(meta!.cwd).toBe('/Users/dev/foo')
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
    // Human prompt + both visible assistant prose messages; tool plumbing and the duplicate final
    // agent_message event are excluded.
    expect(meta!.messageCount).toBe(3)
    expect(meta!.messageCount).toBe(
      countConversationalMessages(parseCodexTranscriptText(jsonl(interactiveLines()), 'abc').messages)
    )
    // task_complete is the last boundary → awaiting
    expect(meta!.turnState).toBe('awaiting')
    expect(meta!.mtime).toBe(123)
    expect(meta!.sizeBytes).toBe(456)
    expect(meta!.threadSource).toBeUndefined()
  })

  it('drops non-interactive (codex exec) rollouts', () => {
    expect(extractCodexMetaFromText(jsonl(interactiveLines({ originator: 'codex_exec' })), 'abc', 1, 1)).toBeNull()
  })

  it('surfaces the subagent thread source for index filtering', () => {
    const meta = extractCodexMetaFromText(
      jsonl(interactiveLines({ threadSource: 'subagent' })),
      'abc',
      1,
      1
    )
    expect(meta).not.toBeNull()
    expect(meta!.threadSource).toBe('subagent')
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
      { timestamp: TS2, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q1', arguments: '{}' } }
    ]
    const meta = extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)!
    expect(meta.turnState).toBe('awaiting_input')
    expect(meta.lastActivityAt).toBe(Date.parse(TS2))
  })

  it('clears awaiting_input once the user answers (matching function_call_output)', () => {
    const lines = [
      { timestamp: TS, type: 'session_meta', payload: { cwd: '/x', originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { timestamp: TS2, type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', call_id: 'q1', arguments: '{}' } },
      { timestamp: TS3, type: 'response_item', payload: { type: 'function_call_output', call_id: 'q1', output: 'yes' } }
    ]
    // No pending input, but still inside the turn (no task_complete yet) → in_progress.
    const meta = extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)!
    expect(meta.turnState).toBe('in_progress')
    expect(meta.lastActivityAt).toBe(Date.parse(TS3))
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
    expect(t.cwd).toBe('/Users/dev/foo')
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

/**
 * The unified `event_msg/item_completed` envelope. Top-level threads emit it INSTEAD of the per-kind
 * `user_message`/`agent_message` events, so a rollout in this shape has no other source for the
 * human turn — without it the sidebar preview, the message count, `firstActivityAt`, and every
 * human turn in the Formatted view all go missing.
 */
describe('item_completed envelope', () => {
  const CWD = '/Users/dev/foo'
  /** Minimal in-progress turn (no task_complete, so the clock isn't overwritten by the boundary). */
  function clockLines(...items: object[]): string {
    return jsonl([
      { timestamp: TS, type: 'session_meta', payload: { cwd: CWD, originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      itemLine(TS, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'go' }] }),
      ...items
    ])
  }

  it('reads the human turn, so title/preview/count/firstActivityAt all populate', () => {
    const meta = extractCodexMetaFromText(jsonl(itemStreamLines()), 'abc', 123, 456)!
    expect(meta.title).toBe('add a dark mode toggle')
    expect(meta.preview).toBe('add a dark mode toggle')
    expect(meta.version).toBe('0.147.0')
    expect(meta.firstActivityAt).toBe(Date.parse(TS))
    // 1 human + 2 assistant. The cross-check is the point: the count and the transcript must agree,
    // which they cannot if only one of the two code paths learned to read the envelope.
    expect(meta.messageCount).toBe(3)
    expect(meta.messageCount).toBe(
      countConversationalMessages(parseCodexTranscriptText(jsonl(itemStreamLines()), 'abc').messages)
    )
  })

  it('builds the same transcript shape as the per-kind stream', () => {
    const t = parseCodexTranscriptText(jsonl(itemStreamLines()), 'abc')
    const roles = t.messages.map((m) => `${m.role}:${m.userKind ?? ''}`)
    expect(roles).toEqual(['user:human', 'assistant:', 'assistant:', 'user:tool_result', 'assistant:'])
    expect(t.messages[0].blocks).toEqual([{ kind: 'text', text: 'add a dark mode toggle' }])
    expect(t.messages[2].blocks[0]).toMatchObject({ kind: 'tool_use', name: 'exec' })
    expect(t.messages[3].blocks[0]).toMatchObject({ kind: 'tool_result', text: 'file.txt\n', isError: false })
  })

  it('ignores every non-UserMessage item, which would otherwise duplicate the transcript', () => {
    // The fixture carries AgentMessage/Reasoning/CommandExecution items that MIRROR response_item
    // lines already read above; reading them too would repeat the assistant prose and tool calls.
    const t = parseCodexTranscriptText(jsonl(itemStreamLines()), 'abc')
    const prose = t.messages.filter((m) => m.blocks.some((b) => b.kind === 'text' && b.text === 'Done.'))
    expect(prose).toHaveLength(1)
    expect(t.messages).toHaveLength(5)
  })

  it('keeps an attached image inline via its [Image #N] placeholder', () => {
    // An image is a SIBLING content part; the text part already holds the placeholder, so joining
    // the text parts reproduces the per-kind event's string and no image block is synthesized.
    const withImage = {
      type: 'UserMessage',
      id: 'u1',
      content: [
        { type: 'local_image', path: '/Users/dev/shot.png' },
        {
          type: 'text',
          text: '[Image #1] \n\nwhat is this?',
          text_elements: [{ byte_range: { start: 0, end: 10 }, placeholder: '[Image #1]' }]
        }
      ]
    }
    const text = jsonl(itemStreamLines({ userItem: withImage }))
    expect(extractCodexMetaFromText(text, 'abc', 1, 1)!.preview).toBe('[Image #1] what is this?')
    expect(parseCodexTranscriptText(text, 'abc').messages[0].blocks).toEqual([
      { kind: 'text', text: '[Image #1] \n\nwhat is this?' }
    ])
  })

  it('advances the activity clock on an AgentMessage item', () => {
    const meta = extractCodexMetaFromText(
      clockLines(itemLine(TS2, { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'working' }] })),
      'abc',
      1,
      1
    )!
    expect(meta.lastActivityAt).toBe(Date.parse(TS2))
  })

  it('does NOT advance the activity clock on Reasoning or CommandExecution items', () => {
    // Treating these as activity would expire an OSC-reported question while the agent is still
    // parked on the user, so the clock must stay at the human turn.
    const meta = extractCodexMetaFromText(
      clockLines(
        itemLine(TS2, { type: 'Reasoning', id: 'rs1', summary_text: [] }),
        itemLine(TS3, { type: 'CommandExecution', id: 'e1', command: 'ls', exit_code: 0 })
      ),
      'abc',
      1,
      1
    )!
    expect(meta.lastActivityAt).toBe(Date.parse(TS))
  })

  it('lets the per-kind stream win when a rollout carries both, so prompts are never doubled', () => {
    const lines = [
      { timestamp: TS, type: 'session_meta', payload: { cwd: CWD, originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      itemLine(TS, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'go' }] }),
      { timestamp: TS2, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }
    ]
    const meta = extractCodexMetaFromText(jsonl(lines), 'abc', 1, 1)!
    expect(meta.messageCount).toBe(1)
    expect(meta.preview).toBe('go')
    const humans = parseCodexTranscriptText(jsonl(lines), 'abc').messages.filter((m) => m.userKind === 'human')
    expect(humans).toHaveLength(1)
  })

  it('still reads the envelope when content merely CONTAINS the token user_message', () => {
    // The per-kind-stream check pre-filters on a substring, so it must verify each candidate line is
    // really the event. These two lines serialize to the literal characters `"user_message"` without
    // being that event — an unescaped array member and an unescaped text value. (Prose that quotes
    // the term does NOT reach here: JSON escapes its quotes.) Mistaking either for the per-kind
    // stream would drop every human turn in this rollout.
    const lines = [
      { timestamp: TS, type: 'session_meta', payload: { cwd: CWD, originator: 'codex-tui' } },
      { timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      itemLine(TS, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'search for that event' }] }),
      {
        timestamp: TS,
        type: 'response_item',
        payload: { type: 'web_search_call', id: 'ws1', action: { type: 'search', queries: ['user_message'] } }
      },
      {
        timestamp: TS2,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'user_message' }] }
      }
    ]
    const text = jsonl(lines)
    // Guard the fixture itself: if this stops holding, the test below proves nothing.
    expect(text).toContain('"user_message"')
    const meta = extractCodexMetaFromText(text, 'abc', 1, 1)!
    expect(meta.title).toBe('search for that event')
    expect(meta.preview).toBe('search for that event')
    expect(meta.firstActivityAt).toBe(Date.parse(TS))
  })
})
