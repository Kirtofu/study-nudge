import type { NudgeBridge } from '../shared/types'

declare global {
  interface Window {
    nudge: NudgeBridge
  }
}

export {}
