import type { NudgeBridge } from '@shared/types'
import type { NudgeStore, StoreGet, StoreSet } from './types'

export function focusActions(
  set: StoreSet,
  get: StoreGet,
  api: NudgeBridge
): Pick<
  NudgeStore,
  | 'startFocus'
  | 'pauseFocus'
  | 'resumeFocus'
  | 'stopFocus'
  | 'skipFocus'
  | 'confirmFocusSwitch'
  | 'cancelFocusSwitch'
  | 'retryFocus'
  | 'refreshStats'
> {
  let retry: (() => Promise<void>) | null = null
  const execute = async (action: () => Promise<void>): Promise<void> => {
    if (get().focusBusy) return
    retry = () => execute(action)
    set({ focusBusy: true, focusError: null })
    try {
      await action()
    } catch (error) {
      set({ focusError: error instanceof Error ? error.message : '计时没有更新，请重试' })
    } finally {
      set({ focusBusy: false })
    }
  }
  return {
    startFocus: async (mode, taskId = null) => {
      const current = get().focusState
      if (
        current &&
        current.status !== 'idle' &&
        (current.taskId !== taskId || current.mode !== mode || current.phase !== 'focus')
      ) {
        set({ pendingFocus: { mode, taskId }, focusError: null })
        return
      }
      await execute(async () => {
        set({ focusState: await api.focus.start({ mode, taskId }) })
      })
    },
    confirmFocusSwitch: () =>
      execute(async () => {
        const request = get().pendingFocus
        if (!request) return
        set({
          focusState: await api.focus.start({ ...request, replaceActive: true }),
          pendingFocus: null
        })
        await get().refreshStats()
      }),
    cancelFocusSwitch: () => set({ pendingFocus: null }),
    pauseFocus: () =>
      execute(async () => {
        set({ focusState: await api.focus.pause() })
      }),
    resumeFocus: () =>
      execute(async () => {
        set({ focusState: await api.focus.resume() })
      }),
    stopFocus: () =>
      execute(async () => {
        set({ focusState: await api.focus.stop(), pendingFocus: null })
        await get().refreshStats()
      }),
    skipFocus: () =>
      execute(async () => {
        set({ focusState: await api.focus.skip() })
        await get().refreshStats()
      }),
    retryFocus: async () => {
      await retry?.()
    },
    refreshStats: async () => {
      set({ focusStats: await api.focus.getStats() })
    }
  }
}
