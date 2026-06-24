// Imports the shared contract by RELATIVE path (not the `@shared` alias) so this stays
// unit-testable under vitest, which has no alias resolution. (Same reason as liveness.ts.)
import { AGENTS, type AgentKind, type TranscriptMessage } from '../../shared/types'

/**
 * A run of consecutive same-source messages, rendered under a single header.
 * Coalescing turns Claude → Claude → Result → Result into one "Claude" group then
 * one "Result" group (one header each) instead of four stacked headers.
 */
export interface MessageGroup {
  /** Stable React key (the first message's uuid). */
  key: string
  /** Header label: the agent's assistant label ('Claude' | 'Codex') | 'You' | 'Result' | 'Error'.
   *  Empty for an interrupt note. */
  label: string
  /** The Esc interrupt sentinel — a standalone muted note, never coalesced with neighbours. */
  interrupted: boolean
  /** True when this group's source is the assistant (the agent). Drives the "Copy turn" affordance
   *  regardless of which label the agent uses (Claude / Codex), so it doesn't string-match the label. */
  isAssistant: boolean
  /** Danger-red source (a tool_result error turn) → red header label. */
  isError: boolean
  /** Sub-agent (sidechain) groups are de-emphasized and never merge with main-chain ones. */
  isSidechain: boolean
  messages: TranscriptMessage[]
}

/** The header label a message would carry on its own. */
function labelFor(m: TranscriptMessage, agent: AgentKind): string {
  if (m.role === 'assistant') return AGENTS[agent].assistantLabel
  if (m.userKind === 'tool_result') {
    const errored = m.blocks.some((b) => b.kind === 'tool_result' && b.isError)
    return errored ? 'Error' : 'Result'
  }
  return 'You'
}

/** Coalescing key: identical key on adjacent messages ⇒ one group. Main/sidechain never merge. */
function sourceKey(m: TranscriptMessage, agent: AgentKind): string {
  return (m.isSidechain ? 'sub:' : 'main:') + labelFor(m, agent)
}

/**
 * Collapse consecutive messages from the same source into groups. A run of same-source
 * messages shares one header; the source changing (Claude → Result, Result → Error, main →
 * sidechain) starts a new group. The interrupt sentinel is always its own group and never
 * merges with its neighbours (so it can't swallow, or be swallowed by, a real turn).
 *
 * `agent` selects the assistant header label ('Claude' / 'Codex'); it defaults to 'claude' so the
 * legacy single-agent callers (and the existing tests) keep working unchanged.
 */
export function buildGroups(
  messages: TranscriptMessage[],
  agent: AgentKind = 'claude'
): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const m of messages) {
    const interrupted = m.userKind === 'interrupted'
    const last = groups[groups.length - 1]
    if (
      !interrupted &&
      last &&
      !last.interrupted &&
      sourceKey(last.messages[0], agent) === sourceKey(m, agent)
    ) {
      last.messages.push(m)
      continue
    }
    const label = interrupted ? '' : labelFor(m, agent)
    groups.push({
      key: m.uuid || `g${groups.length}`,
      label,
      interrupted,
      isAssistant: m.role === 'assistant',
      isError: label === 'Error',
      isSidechain: m.isSidechain,
      messages: [m]
    })
  }
  return groups
}
