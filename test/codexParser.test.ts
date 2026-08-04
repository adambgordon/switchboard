import { describe, it, expect } from 'vitest'
import {
  parseCodexTranscriptText,
  extractCodexMetaFromText,
  matchProvisionalCodex
} from '../src/main/sessions/codexParser'
import { countConversationalMessages } from '../src/shared/messageCount'

const TS = '2026-06-23T14:36:56.000Z'
const TS2 = '2026-06-23T14:37:10.000Z'
const TS3 = '2026-06-23T14:37:20.000Z'

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
  const { originator = 'codex-tui', cwd = '/Volumes/git/foo', threadSource } = opts
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

// --- new-session binding (Phase 3): matchProvisionalCodex (pure correlation) ---

const T = 1_000_000 // a PTY submit time
// The third arg is submitAts — when the user pressed Enter, NOT the spawn time; that distinction IS
// the correlation rule. [] = never submitted. More than one = some Enter produced no turn.
const pty = (ptyId: string, cwd: string, submitAts: number[]) => ({ ptyId, cwd, submitAts })
const cand = (sessionId: string, cwd: string, firstActivityAt: number | null) => ({ sessionId, cwd, firstActivityAt })
// Codex timestamps `user_message` when it PROCESSES the submit, so a rollout's first activity lands
// a few hundred ms after the Enter — not seconds. Fixtures use a realistic lag so that "closest
// submit wins" is exercised the way it behaves live.
const LAG = 120

describe('matchProvisionalCodex', () => {
  it('binds a new rollout (same cwd, first activity just after the submit) to the provisional PTY', () => {
    expect(matchProvisionalCodex([pty('p1', '/x', [T])], [cand('s1', '/x', T + LAG)], new Set())).toEqual([
      { ptyId: 'p1', sessionId: 's1' }
    ])
  })

  it('ignores rollouts in a different cwd', () => {
    expect(matchProvisionalCodex([pty('p1', '/x', [T])], [cand('s1', '/y', T + LAG)], new Set())).toEqual([])
  })

  it('ignores an OLD rollout whose first activity predates the submit (the lower bound)', () => {
    expect(matchProvisionalCodex([pty('p1', '/x', [T])], [cand('old', '/x', T - 600000)], new Set())).toEqual([])
  })

  it('ignores a rollout whose first activity is far LATER than the submit (the upper bound)', () => {
    // Without a finite upper edge, a PTY reaches forward and claims a rollout it cannot have created.
    expect(matchProvisionalCodex([pty('p1', '/x', [T])], [cand('later', '/x', T + 600000)], new Set())).toEqual([])
  })

  it('ignores rollouts with no activity yet', () => {
    expect(matchProvisionalCodex([pty('p1', '/x', [T])], [cand('s1', '/x', null)], new Set())).toEqual([])
  })

  it('excludes ids already driven by a live PTY', () => {
    expect(matchProvisionalCodex([pty('p1', '/x', [T])], [cand('s1', '/x', T + LAG)], new Set(['s1']))).toEqual([])
  })

  it('returns nothing when there are no provisional PTYs', () => {
    expect(matchProvisionalCodex([], [cand('s1', '/x', T + LAG)], new Set())).toEqual([])
  })

  it('pairs each rollout with the submit nearest to it', () => {
    const r = matchProvisionalCodex(
      [pty('pSecond', '/x', [T + 5000]), pty('pFirst', '/x', [T])],
      [cand('sSecond', '/x', T + 5000 + LAG), cand('sFirst', '/x', T + LAG)],
      new Set()
    )
    expect(r).toEqual([
      { ptyId: 'pFirst', sessionId: 'sFirst' },
      { ptyId: 'pSecond', sessionId: 'sSecond' }
    ])
  })

  it('binds each rollout to at most one PTY, keeping the nearer submitter', () => {
    const r = matchProvisionalCodex(
      [pty('pFar', '/x', [T]), pty('pNear', '/x', [T + 4000])],
      [cand('s1', '/x', T + 4000 + LAG)],
      new Set()
    )
    expect(r).toEqual([{ ptyId: 'pNear', sessionId: 's1' }])
  })

  it('is order-independent', () => {
    const ptys = [pty('pA', '/x', [T]), pty('pB', '/x', [T + 5000])]
    const cands = [cand('sA', '/x', T + LAG), cand('sB', '/x', T + 5000 + LAG)]
    const forward = matchProvisionalCodex(ptys, cands, new Set())
    const reversed = matchProvisionalCodex([...ptys].reverse(), [...cands].reverse(), new Set())
    expect(forward).toEqual(reversed)
  })

  // --- regressions: mispairings earlier rules produced ---

  it('an idle tab cannot steal the rollout of a typed tab', () => {
    // pIdle was opened FIRST but never submitted, so it can own nothing. The spawn-time rule served
    // it first and let it take pUsed's rollout, leaving the real row unbound.
    const r = matchProvisionalCodex(
      [pty('pIdle', '/x', []), pty('pUsed', '/x', [T])],
      [cand('s1', '/x', T + LAG)],
      new Set()
    )
    expect(r).toEqual([{ ptyId: 'pUsed', sessionId: 's1' }])
  })

  it('pairs by submit even when submit order is the reverse of spawn order', () => {
    // pSpawnedFirst was spawned first but submitted LAST; the rollouts must follow the submits.
    const r = matchProvisionalCodex(
      [pty('pSpawnedFirst', '/x', [T + 9000]), pty('pSpawnedSecond', '/x', [T + 3000])],
      [cand('sEarly', '/x', T + 3000 + LAG), cand('sLate', '/x', T + 9000 + LAG)],
      new Set()
    )
    expect(r).toEqual([
      { ptyId: 'pSpawnedSecond', sessionId: 'sEarly' },
      { ptyId: 'pSpawnedFirst', sessionId: 'sLate' }
    ])
  })

  it('a submit that produced no turn cannot steal the rollout of another tab', () => {
    // pNoTurn pressed Enter on an empty composer, so it holds a submit but will never have a rollout.
    // Serving submits in order let it take pReal's — permanently, since a bound id enters liveIds.
    const r = matchProvisionalCodex(
      [pty('pNoTurn', '/x', [T]), pty('pReal', '/x', [T + 5000])],
      [cand('sReal', '/x', T + 5000 + LAG)],
      new Set()
    )
    expect(r).toEqual([{ ptyId: 'pReal', sessionId: 'sReal' }])
  })

  it('proximity decides even when the stray submit is inside the window', () => {
    // A gap the upper bound alone would not reject: only "closest wins" separates these.
    const r = matchProvisionalCodex(
      [pty('pNoTurn', '/x', [T]), pty('pReal', '/x', [T + 900])],
      [cand('sReal', '/x', T + 900 + LAG)],
      new Set()
    )
    expect(r).toEqual([{ ptyId: 'pReal', sessionId: 'sReal' }])
  })

  it('a stray submit does not stop the PTY binding its own later rollout', () => {
    // Enter during Codex's launch, then the real prompt 30s later. Anchoring to only the first submit
    // stranded this PTY: its own rollout sat outside the window and never bound.
    const r = matchProvisionalCodex(
      [pty('p1', '/x', [T, T + 30_000])],
      [cand('s1', '/x', T + 30_000 + LAG)],
      new Set()
    )
    expect(r).toEqual([{ ptyId: 'p1', sessionId: 's1' }])
  })

  it('keeps an earlier submit usable after a later one (multi-turn safety)', () => {
    // Submitted, then submitted again before the index caught up. The rollout's first activity still
    // belongs to the EARLIER submit, so it must still match.
    const r = matchProvisionalCodex(
      [pty('p1', '/x', [T, T + 30_000])],
      [cand('s1', '/x', T + LAG)],
      new Set()
    )
    expect(r).toEqual([{ ptyId: 'p1', sessionId: 's1' }])
  })

  it('binds nothing while no provisional PTY has submitted', () => {
    expect(matchProvisionalCodex([pty('p1', '/x', [])], [cand('s1', '/x', T)], new Set())).toEqual([])
  })
})
