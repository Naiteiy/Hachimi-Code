import type { ElectronAPI } from "../preload/types"

declare global {
  interface Window {
    api: ElectronAPI
    __HACHIMICODE__?: {
      deepLinks?: string[]
    }
  }
}
