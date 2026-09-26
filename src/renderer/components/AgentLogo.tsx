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
 *
 * On its own it names its agent, as an image and a tooltip. `decorative` drops both, for a control
 * that names itself: the tooltip layer takes the nearest `data-tip`, so the glyph's own would
 * otherwise replace the control's whenever the pointer is over it.
 */
export default function AgentLogo({
  agent,
  size = 12,
  decorative = false
}: {
  agent: AgentKind
  size?: number
  decorative?: boolean
}) {
  const url = LOGOS[agent]
  const style: CSSProperties = {
    width: size,
    height: size,
    maskImage: `url("${url}")`,
    WebkitMaskImage: `url("${url}")`
  }
  if (decorative) return <span className="sb-agent-logo" style={style} aria-hidden="true" />
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
