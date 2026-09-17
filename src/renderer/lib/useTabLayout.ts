import { useCallback, useState } from 'react'
import { DEFAULT_TAB_LAYOUT, parseTabLayout, type TabLayout } from './tabLayoutPreference'
import { useStorageSync } from './useStorageSync'

// Independent of enablement: switching tabs off must not erase their presentation preference.
const KEY = 'switchboard.tabLayout'

function load(): TabLayout {
  try {
    return parseTabLayout(localStorage.getItem(KEY))
  } catch {
    return DEFAULT_TAB_LAYOUT
  }
}

export function useTabLayout() {
  const [tabLayout, setState] = useState(load)
  useStorageSync(KEY, load, setState)

  const setTabLayout = useCallback((value: TabLayout) => {
    setState(value)
    try {
      localStorage.setItem(KEY, value)
    } catch {
      /* storage unavailable */
    }
  }, [])

  return { tabLayout, setTabLayout }
}
