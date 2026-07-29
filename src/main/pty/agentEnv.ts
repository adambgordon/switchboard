const CLAUDE_CONFIG = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_DISABLE_ADOPT'])

/**
 * Prevent inherited agent identity from affecting spawned sessions. Claude adds new runtime
 * markers over time, so deny its whole environment family while preserving the documented config
 * values that a login shell cannot necessarily reconstruct.
 */
export function cleanAgentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (CLAUDE_CONFIG.has(key)) {
      out[key] = value
      continue
    }
    if (key.startsWith('CLAUDE') || key.startsWith('ANTHROPIC_')) continue
    if (key === 'AI_AGENT' || key === 'NO_COLOR') continue
    out[key] = value
  }
  return out
}
