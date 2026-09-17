import type { ConversationView } from '@shared/navigation'

interface ToggleKey {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
}

type ViewAvailability = 'here' | 'other-pane' | 'claimable' | 'resumable' | null

/** Match the header controls: switch, claim a remote terminal, or explicitly resume a conversation. */
export function viewToggleAction(
  key: ToggleKey,
  view: ConversationView,
  availability: ViewAvailability
): ConversationView | 'claim' | 'resume' | null {
  // Ctrl+J is terminal input. Holding Cmd+J must not repeatedly swap the focused surface.
  if (key.code !== 'KeyJ' || !key.metaKey || key.ctrlKey || key.altKey || key.shiftKey || key.repeat) {
    return null
  }
  if (availability === 'resumable' && view === 'transcript') return 'resume'
  if (availability === 'claimable') return 'claim'
  if (availability !== 'here') return null
  return view === 'terminal' ? 'transcript' : 'terminal'
}
