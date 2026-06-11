// Imports the shared contract by RELATIVE path (not the `@shared` alias) so this stays
// unit-testable under vitest, which has no alias resolution. (Same reason as liveness.ts.)
import type { TranscriptMessage } from '../../shared/types'

/**
 * A run of consecutive same-source messages, rendered under a single header.
 * Coalescing turns Claude → Claude → Result → Result into one "Claude" group then
 * one "Result" group (one header each) instead of four stacked headers.
 */
export interface MessageGroup {
  /** Stable React key (the first message's uuid). */
  key: string
  /** Header label: 'Claude' | 'You' | 'Result' | 'Error'. Empty for an interrupt note. */
  label: string
  /** The Esc interrupt sentinel — a standalone muted note, never coalesced with neighbours. */
  interrupted: boolean
  /** Danger-red source (a tool_result error turn) → red header label. */
  isError: boolean
  /** Sub-agent (sidechain) groups are de-emphasized and never merge with main-chain ones. */
  isSidechain: boolean
  messages: TranscriptMessage[]
}

/** The header label a message would carry on its own. */
function labelFor(m: TranscriptMessage): string {
  if (m.role === 'assistant') return 'Claude'
  if (m.userKind === 'tool_result') {
    const errored = m.blocks.some((b) => b.kind === 'tool_result' && b.isError)
    return errored ? 'Error' : 'Result'
  }
  return 'You'
}

/** Coalescing key: identical key on adjacent messages ⇒ one group. Main/sidechain never merge. */
function sourceKey(m: TranscriptMessage): string {
  return (m.isSidechain ? 'sub:' : 'main:') + labelFor(m)
}

/**
 * Collapse consecutive messages from the same source into groups. A run of same-source
 * messages shares one header; the source changing (Claude → Result, Result → Error, main →
 * sidechain) starts a new group. The interrupt sentinel is always its own group and never
 * merges with its neighbours (so it can't swallow, or be swallowed by, a real turn).
 */
export function buildGroups(messages: TranscriptMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []
  for (const m of messages) {
    const interrupted = m.userKind === 'interrupted'
    const last = groups[groups.length - 1]
    if (!interrupted && last && !last.interrupted && sourceKey(last.messages[0]) === sourceKey(m)) {
      last.messages.push(m)
      continue
    }
    const label = interrupted ? '' : labelFor(m)
    groups.push({
      key: m.uuid || `g${groups.length}`,
      label,
      interrupted,
      isError: label === 'Error',
      isSidechain: m.isSidechain,
      messages: [m]
    })
  }
  return groups
}
