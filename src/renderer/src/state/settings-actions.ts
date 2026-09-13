import type { NudgeBridge, SyncState } from '@shared/types'
import type { NudgeStore, StoreGet, StoreSet } from './types'
export function settingsActions(
  set: StoreSet,
  get: StoreGet,
  api: NudgeBridge,
  scheduleAutomaticSync: (delay?: number) => void
): Pick<
  NudgeStore,
  | 'updateSettings'
  | 'updateRecommendationSettings'
  | 'configureSync'
  | 'runSync'
  | 'disconnectSync'
  | 'refreshSync'
> {
  let syncRunPromise: Promise<SyncState> | null = null
  return {
    updateSettings: async (input) => {
      const settings = await api.settings.update(input)
      set({ settings })
      await get().refreshStats()
      return settings
    },

    updateRecommendationSettings: async (input) => {
      const recommendationSettings = await api.recommendation.updateSettings(input)
      set({ recommendationSettings })
      return recommendationSettings
    },

    configureSync: async (input) => {
      const syncSettings = await api.sync.configure(input)
      const syncState = await api.sync.getState()
      set({ syncSettings, syncState })
      if (syncSettings.rememberPassphrase) scheduleAutomaticSync(250)
      return syncSettings
    },

    runSync: async () => {
      const currentSettings = get().syncSettings
      if (currentSettings?.enabled && !currentSettings.syncV3Confirmed) {
        const confirmed = window.confirm(
          '远端同步文件需要升级为 schema 3。连接同一文件的其他设备需要使用 Nudge v2.1 或更新版本；升级后 v2.0 将停止同步。是否继续？'
        )
        if (!confirmed) throw new Error('已取消同步格式升级')
        set({ syncSettings: await api.sync.confirmUpgrade() })
      }
      if (!syncRunPromise) {
        syncRunPromise = api.sync
          .run()
          .then(async (syncState) => {
            set({ syncState, syncConflicts: await api.sync.listConflicts() })
            return syncState
          })
          .finally(() => {
            syncRunPromise = null
          })
      }
      return syncRunPromise
    },

    disconnectSync: async () => {
      await api.sync.disconnect()
      const [syncSettings, syncState] = await Promise.all([
        api.sync.getSettings(),
        api.sync.getState()
      ])
      set({ syncSettings, syncState, syncConflicts: [] })
    },

    refreshSync: async () => {
      const [syncSettings, syncState, syncConflicts] = await Promise.all([
        api.sync.getSettings(),
        api.sync.getState(),
        api.sync.listConflicts()
      ])
      set({ syncSettings, syncState, syncConflicts })
    }
  }
}
