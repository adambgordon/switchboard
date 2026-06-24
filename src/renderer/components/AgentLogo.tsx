import type { CSSProperties } from 'react'
import { AGENTS, type AgentKind } from '@shared/types'
import claudeLogo from '../assets/agents/claude.svg'
import codexLogo from '../assets/agents/codex.svg'

const LOGOS: Record<AgentKind, string> = {
  claude: claudeLogo,
  codex: codexLogo
}

/**
 * A small per-agent logo. Painted as a CSS mask (see `.sb-agent-logo` in rail.css) so it renders in
 * the surrounding text color via `currentColor` — grayscale, and theme-aware for free — regardless
 * of the source SVG's own fill (Claude's is orange, ChatGPT's black). The mask URL is set inline
 * (Vite resolves the import to a hashed asset URL); size + color come from CSS.
 */
export default function AgentLogo({ agent, size = 12 }: { agent: AgentKind; size?: number }) {
  const url = LOGOS[agent]
  const style: CSSProperties = {
    width: size,
    height: size,
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`
  }
  return (
    <span
      className="sb-agent-logo"
      style={style}
      role="img"
      aria-label={AGENTS[agent].label}
      data-tip={AGENTS[agent].label}
    />
  )
}
