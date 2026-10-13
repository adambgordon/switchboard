import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootCommandFor, bootPayloadFor } from '../src/main/pty/bootCommand'

const ID = 'eb583f11-9020-45a7-af51-b23f2e2cb3cc'
const CLEAR = '\x05\x15' // Ctrl-E + Ctrl-U — kill whatever is on the input line
const NO_DAEMON_IF_SUPPORTED = '$(codex --help 2>/dev/null | grep -q -e --no-daemon && echo --no-daemon)'
const CODEX =
  `codex ${NO_DAEMON_IF_SUPPORTED} -c 'tui.terminal_resize_reflow_max_rows=1000' ` +
  "-c 'tui.notifications=[\"approval-requested\",\"plan-mode-prompt\"]' " +
  "-c 'tui.notification_method=\"osc9\"' -c 'tui.notification_condition=\"always\"'"

describe('bootCommandFor', () => {
  it('claude new uses a pre-assigned --session-id', () => {
    expect(bootCommandFor('claude', 'new', ID)).toBe(`claude --session-id ${ID}`)
  })
  it('claude resume uses --resume', () => {
    expect(bootCommandFor('claude', 'resume', ID)).toBe(`claude --resume ${ID}`)
  })
  it('codex new caps terminal history replay without assigning an id', () => {
    expect(bootCommandFor('codex', 'new', ID)).toBe(CODEX)
  })
  it('codex resume caps terminal history replay', () => {
    expect(bootCommandFor('codex', 'resume', ID)).toBe(`${CODEX} resume ${ID}`)
  })
  it('codex enables only process-local OSC input notifications', () => {
    const command = bootCommandFor('codex', 'new', ID)
    expect(command).toContain(
      "-c 'tui.notifications=[\"approval-requested\",\"plan-mode-prompt\"]'"
    )
    expect(command).toContain("-c 'tui.notification_method=\"osc9\"'")
    expect(command).toContain("-c 'tui.notification_condition=\"always\"'")
  })

  it('codex excludes turn-complete previews that can resemble input notifications', () => {
    const command = bootCommandFor('codex', 'new', ID)
    expect(command).not.toContain("-c 'tui.notifications=true'")
    expect(command).not.toContain('agent-turn-complete')
  })
})

// The `--no-daemon` decision is made by the terminal's shell, so only a real shell can show it is
// right: run the generated command against stub `codex` binaries and record the arguments the final
// invocation receives. The older stub's help lists a neighboring `--no-` flag, as real releases do.
describe('bootCommandFor — the shell decides --no-daemon', () => {
  const DIR = mkdtempSync(join(tmpdir(), 'sb-bootcommand-test-'))
  const ARGV_LOG = join(DIR, 'argv')
  const OLDER = join(DIR, 'older')
  const NEWER = join(DIR, 'newer')
  const OVERRIDE_ARGS = [
    '-c',
    'tui.terminal_resize_reflow_max_rows=1000',
    '-c',
    'tui.notifications=["approval-requested","plan-mode-prompt"]',
    '-c',
    'tui.notification_method="osc9"',
    '-c',
    'tui.notification_condition="always"'
  ]
  const SHELLS = ['/bin/zsh', '/bin/bash'].filter((s) => existsSync(s))

  const stub = (dir: string, help: string): void => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'codex')
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = "--help" ]; then printf '%s\\n' ${help}; exit 0; fi\n` +
        `printf '%s\\n' "$@" > "${ARGV_LOG}"\n`
    )
    chmodSync(path, 0o755)
  }

  const argvFrom = (shell: string, stubDir: string, command: string): string[] => {
    rmSync(ARGV_LOG, { force: true })
    execFileSync(shell, ['-c', command], { env: { PATH: `${stubDir}:/usr/bin:/bin` } })
    return readFileSync(ARGV_LOG, 'utf8').split('\n').slice(0, -1)
  }

  beforeAll(() => {
    stub(OLDER, `'      --no-alt-screen' '          Disable alternate screen mode'`)
    stub(
      NEWER,
      `'      --no-alt-screen' '          Disable alternate screen mode' ` +
        `'      --no-daemon' '          Run without the shared background server'`
    )
  })
  afterAll(() => rmSync(DIR, { recursive: true, force: true }))

  it.each(SHELLS)('%s passes --no-daemon to a Codex whose help lists it', (shell) => {
    expect(argvFrom(shell, NEWER, bootCommandFor('codex', 'new', ID))).toEqual(['--no-daemon', ...OVERRIDE_ARGS])
    expect(argvFrom(shell, NEWER, bootCommandFor('codex', 'resume', ID))).toEqual([
      '--no-daemon',
      ...OVERRIDE_ARGS,
      'resume',
      ID
    ])
  })

  it.each(SHELLS)('%s leaves no argument at all for a Codex that predates the flag', (shell) => {
    expect(argvFrom(shell, OLDER, bootCommandFor('codex', 'new', ID))).toEqual(OVERRIDE_ARGS)
    expect(argvFrom(shell, OLDER, bootCommandFor('codex', 'resume', ID))).toEqual([...OVERRIDE_ARGS, 'resume', ID])
  })
})

describe('bootPayloadFor', () => {
  const cases = [
    ['claude', 'new'],
    ['claude', 'resume'],
    ['codex', 'new'],
    ['codex', 'resume']
  ] as const

  it('clears the line first and submits with CR, leaving the command untouched between', () => {
    for (const [agent, origin] of cases) {
      const payload = bootPayloadFor(agent, origin, ID)
      expect(payload.startsWith(CLEAR)).toBe(true)
      expect(payload.endsWith('\r')).toBe(true)
      expect(payload).toBe(`${CLEAR}${bootCommandFor(agent, origin, ID)}\r`)
    }
  })

  it('prevents the two-command fusion bug: the payload begins by killing the line', () => {
    // Regression guard for the observed `claude --session-id <id>claude --resume <id>` corruption,
    // where a recalled history line prefixed the boot command and claude rejected the combination.
    // The leading Ctrl-U kills anything already on the line, so it can never prefix our command.
    expect(bootPayloadFor('claude', 'resume', ID)).toBe(`\x05\x15claude --resume ${ID}\r`)
  })
})
