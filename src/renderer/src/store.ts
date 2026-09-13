import type { DataChangedEvent, DataDomain, NudgeBridge } from '@shared/types'
import { create } from 'zustand'
import { api } from './bridge'
import { localDay } from './features/tasks/model'
import { focusActions } from './state/focus-actions'
import { learningActions } from './state/learning-actions'
import { settingsActions } from './state/settings-actions'
import { taskActions } from './state/task-actions'
import type { NudgeStore } from './state/types'

const ALL_DOMAINS: DataDomain[] = [
  'tasks',
  'lists',
  'tags',
  'settings',
  'focus',
  'learning',
  'recommendation',
  'sync'
]

export function createNudgeStore(bridge: NudgeBridge = api) {
  return create<NudgeStore>((set, get) => {
    const tasks = taskActions(set, get, bridge)
    let subscriptions: Array<() => void> = []
    let installed = false
    let mini = false
    let automaticSyncTimer: ReturnType<typeof setTimeout> | undefined
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let dayTimer: ReturnType<typeof setTimeout> | undefined
    const dirty = new Set<DataDomain>()
    const generations = new Map<DataDomain, number>()
    const scheduleAutomaticSync = (delay = 5_000): void => {
      clearTimeout(automaticSyncTimer)
      automaticSyncTimer = setTimeout(() => {
        const state = get()
        if (
          mini ||
          !state.initialized ||
          !state.syncSettings?.enabled ||
          !state.syncSettings.rememberPassphrase ||
          !state.syncSettings.syncV3Confirmed ||
          state.syncState?.status === 'syncing'
        )
          return
        void state
          .runSync()
          .catch((error: unknown) =>
            set({
              backgroundError:
                error instanceof Error ? error.message : '同步未完成，可以在设置中重试'
            })
          )
      }, delay)
    }
    const refreshData = async (domains = ALL_DOMAINS): Promise<void> => {
      const jobs: Promise<unknown>[] = []
      const refresh = <T>(
        domain: DataDomain,
        fetch: () => Promise<T>,
        apply: (value: T) => void
      ): void => {
        const generation = (generations.get(domain) ?? 0) + 1
        generations.set(domain, generation)
        jobs.push(
          fetch().then((value) => {
            if (generations.get(domain) === generation) apply(value)
          })
        )
      }
      if (domains.some((domain) => domain === 'tasks' || domain === 'tags'))
        jobs.push(tasks.actions.refreshTasks())
      if (domains.includes('lists')) refresh('lists', bridge.lists.list, (lists) => set({ lists }))
      if (domains.includes('settings'))
        refresh('settings', bridge.settings.get, (settings) => set({ settings }))
      if (domains.includes('focus')) {
        const previous = get().focusState
        refresh(
          'focus',
          () => Promise.all([bridge.focus.getState(), bridge.focus.getStats()]),
          ([focusState, focusStats]) =>
            set({ focusStats, ...(get().focusState === previous ? { focusState } : {}) })
        )
      }
      if (domains.includes('recommendation'))
        refresh('recommendation', bridge.recommendation.getSettings, (recommendationSettings) =>
          set({ recommendationSettings })
        )
      if (domains.includes('sync')) jobs.push(get().refreshSync())
      if (domains.includes('learning')) {
        for (const id of Object.keys(get().learningPacks)) jobs.push(get().refreshLearning(id))
      }
      const results = await Promise.allSettled(jobs)
      const failure = results.find((result) => result.status === 'rejected')
      set({
        backgroundError:
          failure?.status === 'rejected'
            ? failure.reason instanceof Error
              ? failure.reason.message
              : '部分数据没有刷新，请重试'
            : null
      })
    }
    const onData = (event: DataChangedEvent): void => {
      event.domains.forEach((domain) => dirty.add(domain))
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        const domains = [...dirty]
        dirty.clear()
        void refreshData(domains)
      }, 60)
      if (event.source !== 'sync') scheduleAutomaticSync()
    }
    const updateDay = (): void => {
      clearTimeout(dayTimer)
      const today = localDay()
      if (today !== get().today) {
        set({ today })
        void refreshData(['focus'])
      }
      const now = new Date()
      dayTimer = setTimeout(
        updateDay,
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() -
          now.getTime() +
          50
      )
    }
    const install = (): void => {
      if (installed) return
      installed = true
      subscriptions = [
        bridge.app.onDataChanged(onData),
        bridge.focus.onChange((focusState) => {
          set({ focusState })
          onData({ domains: ['focus'], source: 'local' })
        }),
        bridge.learning.onProgress((progress) => {
          set((state) => ({
            learningProgress: {
              ...state.learningProgress,
              [progress.taskId]: {
                ...state.learningProgress[progress.taskId],
                [progress.section]: progress
              }
            }
          }))
          if (['success', 'error', 'canceled'].includes(progress.state))
            void get()
              .refreshLearning(progress.taskId)
              .catch(() => undefined)
        }),
        bridge.sync.onStateChanged((syncState) => {
          set({ syncState })
          if (syncState.status === 'conflict')
            void get()
              .refreshSync()
              .catch(() => undefined)
        })
      ]
      const wake = (): void => {
        updateDay()
        scheduleAutomaticSync(500)
        void refreshData(['focus'])
      }
      const visible = (): void => {
        if (document.visibilityState === 'visible') wake()
      }
      window.addEventListener('focus', wake)
      document.addEventListener('visibilitychange', visible)
      subscriptions.push(
        () => window.removeEventListener('focus', wake),
        () => document.removeEventListener('visibilitychange', visible)
      )
      updateDay()
    }
    const initialize = async (): Promise<void> => {
      install()
      if (get().initialized || get().loading) return
      set({ loading: true, error: null })
      try {
        const snapshot = await bridge.app.bootstrap()
        set({ ...snapshot, initialized: true, loading: false, error: null })
        tasks.hydrate(snapshot.tasks, snapshot.tags)
        if (!mini) scheduleAutomaticSync(750)
      } catch (error) {
        set({
          loading: false,
          error: error instanceof Error ? error.message : '本地数据没有打开成功'
        })
      }
    }
    return {
      initialized: false,
      loading: false,
      error: null,
      backgroundError: null,
      today: localDay(),
      tasks: [],
      lists: [],
      tags: [],
      settings: null,
      focusState: null,
      focusStats: null,
      focusBusy: false,
      focusError: null,
      pendingFocus: null,
      learningPacks: {},
      learningProgress: {},
      learningErrors: {},
      openLearningTaskId: null,
      recommendationSettings: null,
      syncSettings: null,
      syncState: null,
      syncConflicts: [],
      secretStore: null,
      currentView: 'today',
      search: '',
      selectedTaskId: null,
      drawerMode: null,
      commandOpen: false,
      initialize,
      initializeMini: async () => {
        mini = true
        await initialize()
      },
      refreshData,
      dispose: () => {
        subscriptions.forEach((off) => off())
        subscriptions = []
        installed = false
        clearTimeout(automaticSyncTimer)
        clearTimeout(refreshTimer)
        clearTimeout(dayTimer)
      },
      setView: (currentView) =>
        set({
          currentView,
          search: '',
          selectedTaskId: null,
          drawerMode: null,
          openLearningTaskId: null
        }),
      setSearch: (search) => set({ search }),
      selectTask: (selectedTaskId) =>
        set({
          selectedTaskId,
          drawerMode: selectedTaskId ? 'task' : null,
          openLearningTaskId: null
        }),
      openSettings: () =>
        set({ drawerMode: 'settings', selectedTaskId: null, openLearningTaskId: null }),
      openFocusHistory: () =>
        set({ drawerMode: 'focus-history', selectedTaskId: null, openLearningTaskId: null }),
      closeDrawer: () => set({ drawerMode: null, selectedTaskId: null }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      ...tasks.actions,
      ...focusActions(set, get, bridge),
      ...learningActions(set, get, bridge),
      ...settingsActions(set, get, bridge, scheduleAutomaticSync)
    }
  })
}

export const useNudgeStore = createNudgeStore()
