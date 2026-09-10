import type { ConversationView } from '@shared/navigation'

interface ToggleKey {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
}

type TerminalLocation = 'here' | 'other-pane' | 'claimable' | null

/** Match the header controls: a remote terminal is claimed, and an unavailable one stays put. */
export function viewToggleAction(
  key: ToggleKey,
  view: ConversationView,
  terminalAt: TerminalLocation
): ConversationView | 'claim' | null {
  // Ctrl+J is terminal input. Holding Cmd+J must not repeatedly swap the focused surface.
  if (key.code !== 'KeyJ' || !key.metaKey || key.ctrlKey || key.altKey || key.shiftKey || key.repeat) {
    return null
  }
  if (terminalAt === 'claimable') return 'claim'
  if (terminalAt !== 'here') return null
  return view === 'terminal' ? 'transcript' : 'terminal'
}
