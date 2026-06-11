/// <reference types="vite/client" />
import type { SwitchboardApi } from '../shared/types'

declare global {
  interface Window {
    api: SwitchboardApi
    platform: string
    /** Dev-only branch label from SWITCHBOARD_DEV_LABEL; null in normal/packaged runs. */
    devLabel: string | null
  }
}

export {}
