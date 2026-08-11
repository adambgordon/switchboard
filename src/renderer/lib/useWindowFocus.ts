import { useEffect, useState } from 'react'
import { startFocusSync } from './focusSync'

/**
 * Whether the app window currently has OS focus. Used to decide when a selected conversation counts
 * as "seen": you've only really looked at a finished turn if Switchboard was focused while that
 * conversation was selected.
 *
 * The value comes entirely from the main process (see main/windowFocus.ts). The renderer does NOT
 * observe its own focus: `document.hasFocus()` can disagree with the window's actual state, and as a
 * seed read during render it is also racy — a `focus` arriving before the listeners attach is lost,
 * and nothing re-samples, so the flag stays false for the life of the process and everything gated
 * on it silently stops.
 *
 * The subscribe/seed ordering that makes this correct lives in `focusSync` so it can be unit-tested;
 * this hook is only the React binding.
 */
export function useWindowFocus(): boolean {
  // Starts false, not true. The costs are asymmetric: a wrong `false` shows one extra unread dot
  // until the seed lands, while a wrong `true` marks a conversation read — advancing a
  // forward-only, persisted marker that cannot be recovered.
  const [focused, setFocused] = useState(false)

  useEffect(
    () =>
      startFocusSync({
        subscribe: (cb) => window.api.onWindowFocusChanged(cb),
        querySeed: () => window.api.isWindowFocused(),
        apply: setFocused
      }),
    []
  )

  return focused
}
