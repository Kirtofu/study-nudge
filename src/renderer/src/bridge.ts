import type { NudgeBridge } from '@shared/types'
import { createTauriBridge } from './bridge/native'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}
export const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
// The demo adapter is an independent chunk and never loads in the desktop app.
export const api: NudgeBridge = isTauri
  ? createTauriBridge()
  : (await import('./bridge/demo')).createDemoBridge()
