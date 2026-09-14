import type { DshApi } from '@shared/api'

declare global {
  interface Window {
    api: DshApi
  }
}

export {}
