import { describe, expect, it } from 'vitest'
import { cleanAgentEnv } from '../src/main/pty/agentEnv'

describe('cleanAgentEnv', () => {
  it('removes inherited agent identity while preserving explicit configuration', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_EFFORT: 'high',
      CLAUDE_PID: '12345',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_JOB_DIR: '/jobs/claude',
      CLAUDE_BG_SOURCE: 'background',
      CLAUDE_PROJECT_DIR: '/project',
      CLAUDE_FUTURE_RUNTIME_MARKER: 'future',
      ANTHROPIC_API_KEY: 'secret',
      AI_AGENT: 'claude',
      NO_COLOR: '1',
      CLAUDE_CONFIG_DIR: '/configs/claude',
      CLAUDE_DISABLE_ADOPT: '1',
      CODEX_HOME: '/configs/codex',
      CODEX_THREAD_ID: 'thread'
    }

    expect(cleanAgentEnv(source)).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/configs/claude',
      CLAUDE_DISABLE_ADOPT: '1',
      CODEX_HOME: '/configs/codex',
      CODEX_THREAD_ID: 'thread'
    })
  })
})
