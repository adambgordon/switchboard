import { useEffect, useState } from 'react'

/**
 * Whether the app window currently has OS focus. Used to decide when a selected
 * conversation counts as "seen": you've only really looked at a finished turn if
 * Switchboard was focused while that conversation was selected.
 */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document !== 'undefined' ? document.hasFocus() : true
  )

  useEffect(() => {
    const on = (): void => setFocused(true)
    const off = (): void => setFocused(false)
    window.addEventListener('focus', on)
    window.addEventListener('blur', off)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', off)
    }
  }, [])

  return focused
}
