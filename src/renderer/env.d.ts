/// <reference types="vite/client" />
import type { SwitchboardApi, WindowInit } from '../shared/types'

declare global {
  interface Window {
    api: SwitchboardApi
    platform: string
    /** Dev-only branch label from SWITCHBOARD_DEV_LABEL; null in normal/packaged runs. */
    devLabel: string | null
    /** Dev-only updater preview from SWITCHBOARD_FAKE_UPDATING. */
    fakeUpdating: boolean
    /** What this window was opened to show. Synchronous, so the first render is already right — see
     *  the preload's readWindowInit. An ordinary browser window gets `{ null, false }`. */
    sbWindow: WindowInit
  }
}

export {}
