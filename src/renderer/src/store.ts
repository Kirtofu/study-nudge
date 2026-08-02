import { create } from 'zustand'
import type {
  AppSettings,
  CreateTaskInput,
  FocusState,
  FocusStats,
  LearningPack,
  LearningProgressEvent,
  LearningSection,
  RecommendationSettings,
  SyncConflict,
  SyncSettings,
  SyncState,
  Tag,
  Task,
  TaskList,
  UpdateTaskInput,
  ViewId
} from '@shared/types'
import { api } from './bridge'

type DrawerMode = 'task' | 'settings' | null

interface NudgeStore {
  initialized: boolean
  loading: boolean
  error: string | null
  tasks: Task[]
  lists: TaskList[]
  tags: Tag[]
  settings: AppSettings | null
  focusState: FocusState | null
  focusStats: FocusStats | null
  learningPacks: Record<string, LearningPack>
  learningProgress: Record<string, Partial<Record<LearningSection, LearningProgressEvent>>>
  openLearningTaskId: string | null
  recommendationSettings: RecommendationSettings | null
  syncSettings: SyncSettings | null
  syncState: SyncState | null
  syncConflicts: SyncConflict[]
  currentView: ViewId
  search: string
  selectedTaskId: string | null
  drawerMode: DrawerMode
  commandOpen: boolean
  initialize: () => Promise<void>
  initializeMini: () => Promise<void>
  refreshTasks: () => Promise<void>
  refreshStats: () => Promise<void>
  setView: (view: ViewId) => void
  setSearch: (search: string) => void
  selectTask: (taskId: string | null) => void
  openSettings: () => void
  closeDrawer: () => void
  setCommandOpen: (open: boolean) => void
  createTask: (input: CreateTaskInput) => Promise<Task>
  updateTask: (id: string, input: UpdateTaskInput) => Promise<Task>
  completeTask: (id: string, completed: boolean) => Promise<Task>
  deleteTask: (id: string) => Promise<void>
  restoreTask: (id: string) => Promise<Task>
  reorderTasks: (ids: string[]) => Promise<void>
  createList: (name: string) => Promise<TaskList>
  updateList: (id: string, input: { name?: string; color?: string }) => Promise<TaskList>
  deleteList: (id: string) => Promise<void>
  startFocus: (mode: 'pomodoro' | 'stopwatch', taskId?: string | null) => Promise<void>
  pauseFocus: () => Promise<void>
  resumeFocus: () => Promise<void>
  stopFocus: () => Promise<void>
  skipFocus: () => Promise<void>
  updateSettings: (input: Partial<AppSettings>) => Promise<AppSettings>
  openLearning: (taskId: string) => Promise<LearningPack>
  closeLearning: () => void
  refreshLearning: (taskId: string) => Promise<LearningPack | null>
  generateLearning: (taskId: string, sections?: LearningSection[]) => Promise<LearningPack>
  updateRecommendationSettings: (input: Partial<RecommendationSettings> & { apiKey?: string; clearApiKey?: boolean }) => Promise<RecommendationSettings>
  configureSync: (input: Parameters<typeof api.sync.configure>[0]) => Promise<SyncSettings>
  runSync: () => Promise<SyncState>
  disconnectSync: () => Promise<void>
  refreshSync: () => Promise<void>
}

let focusUnsubscribe: (() => void) | null = null
let learningUnsubscribe: (() => void) | null = null
let syncUnsubscribe: (() => void) | null = null
let automaticSyncTimer: ReturnType<typeof setTimeout> | null = null
let syncRunPromise: Promise<SyncState> | null = null
let syncLifecycleInstalled = false

function scheduleAutomaticSync(delay = 5_000): void {
  if (automaticSyncTimer) clearTimeout(automaticSyncTimer)
  automaticSyncTimer = setTimeout(() => {
    automaticSyncTimer = null
    const state = useNudgeStore.getState()
    if (
      !state.initialized ||
      !state.syncSettings?.enabled ||
      !state.syncSettings.rememberPassphrase ||
      state.syncState?.status === 'syncing'
    ) return
    void state.runSync().catch(() => undefined)
  }, delay)
}

function installSyncLifecycle(): void {
  if (syncLifecycleInstalled || typeof window === 'undefined') return
  syncLifecycleInstalled = true
  window.addEventListener('nudge-local-change', () => scheduleAutomaticSync())
  window.addEventListener('focus', () => scheduleAutomaticSync(500))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleAutomaticSync(500)
  })
}

export const useNudgeStore = create<NudgeStore>((set, get) => ({
  initialized: false,
  loading: false,
  error: null,
  tasks: [],
  lists: [],
  tags: [],
  settings: null,
  focusState: null,
  focusStats: null,
  learningPacks: {},
  learningProgress: {},
  openLearningTaskId: null,
  recommendationSettings: null,
  syncSettings: null,
  syncState: null,
  syncConflicts: [],
  currentView: 'today',
  search: '',
  selectedTaskId: null,
  drawerMode: null,
  commandOpen: false,

  initialize: async () => {
    if (get().initialized || get().loading) return
    set({ loading: true, error: null })
    try {
      const [tasks, lists, tags, settings, focusState, focusStats, recommendationSettings, syncSettings, syncState, syncConflicts] = await Promise.all([
        api.tasks.list(),
        api.lists.list(),
        api.tags.list(),
        api.settings.get(),
        api.focus.getState(),
        api.focus.getStats(),
        api.recommendation.getSettings(),
        api.sync.getSettings(),
        api.sync.getState(),
        api.sync.listConflicts()
      ])
      focusUnsubscribe?.()
      focusUnsubscribe = api.focus.onChange((state) => {
        set({ focusState: state })
        void get().refreshStats()
      })
      learningUnsubscribe?.()
      learningUnsubscribe = api.learning.onProgress((progress) => {
        set((state) => ({
          learningProgress: {
            ...state.learningProgress,
            [progress.taskId]: {
              ...state.learningProgress[progress.taskId],
              [progress.section]: progress
            }
          }
        }))
        if (progress.state === 'success' || progress.state === 'error' || progress.state === 'canceled') {
          void get().refreshLearning(progress.taskId)
        }
      })
      syncUnsubscribe?.()
      syncUnsubscribe = api.sync.onStateChanged((next) => {
        set({ syncState: next })
        if (next.status === 'conflict') void get().refreshSync()
      })
      set({
        initialized: true,
        loading: false,
        error: null,
        tasks,
        lists,
        tags,
        settings,
        focusState,
        focusStats,
        recommendationSettings,
        syncSettings,
        syncState,
        syncConflicts
      })
      installSyncLifecycle()
      if (syncSettings.enabled && syncSettings.rememberPassphrase) scheduleAutomaticSync(750)
      void api.desktop.platform().then((platform) => {
        if (platform === 'android' || platform === 'ios') {
          void api.desktop.prepareNotifications().catch(() => false)
        }
      })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '本地数据没有打开成功'
      })
    }
  },

  initializeMini: async () => {
    if (get().initialized || get().loading) return
    set({ loading: true, error: null })
    try {
      const [tasks, settings, focusState] = await Promise.all([
        api.tasks.list(),
        api.settings.get(),
        api.focus.getState()
      ])
      focusUnsubscribe?.()
      focusUnsubscribe = api.focus.onChange((state) => set({ focusState: state }))
      set({
        initialized: true,
        loading: false,
        error: null,
        tasks,
        settings,
        focusState
      })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '专注计时没有打开成功'
      })
    }
  },

  refreshTasks: async () => {
    const [tasks, tags] = await Promise.all([api.tasks.list(), api.tags.list()])
    set({ tasks, tags })
  },

  refreshStats: async () => {
    set({ focusStats: await api.focus.getStats() })
  },

  setView: (currentView) => set({ currentView, selectedTaskId: null, drawerMode: null, openLearningTaskId: null }),
  setSearch: (search) => set({ search }),
  selectTask: (selectedTaskId) =>
    set({ selectedTaskId, drawerMode: selectedTaskId ? 'task' : null, openLearningTaskId: null }),
  openSettings: () => set({ drawerMode: 'settings', selectedTaskId: null, openLearningTaskId: null }),
  closeDrawer: () => set({ drawerMode: null, selectedTaskId: null }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),

  createTask: async (input) => {
    const task = await api.tasks.create(input)
    await get().refreshTasks()
    set({ selectedTaskId: task.parentId ? get().selectedTaskId : task.id, drawerMode: 'task' })
    return task
  },

  updateTask: async (id, input) => {
    const task = await api.tasks.update(id, input)
    await get().refreshTasks()
    return task
  },

  completeTask: async (id, completed) => {
    const task = await api.tasks.complete(id, completed)
    await get().refreshTasks()
    return task
  },

  deleteTask: async (id) => {
    await api.tasks.delete(id)
    await get().refreshTasks()
    if (get().selectedTaskId === id) set({ selectedTaskId: null, drawerMode: null })
  },

  restoreTask: async (id) => {
    const task = await api.tasks.restore(id)
    await get().refreshTasks()
    return task
  },

  reorderTasks: async (ids) => {
    const position = new Map(ids.map((id, index) => [id, index]))
    set({
      tasks: [...get().tasks].sort(
        (a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      )
    })
    await api.tasks.reorder(ids)
    await get().refreshTasks()
  },

  createList: async (name) => {
    const list = await api.lists.create(name)
    set({ lists: await api.lists.list(), currentView: `list:${list.id}` })
    return list
  },

  updateList: async (id, input) => {
    const list = await api.lists.update(id, input)
    set({ lists: await api.lists.list() })
    return list
  },

  deleteList: async (id) => {
    await api.lists.delete(id)
    set({ lists: await api.lists.list(), currentView: 'inbox' })
    await get().refreshTasks()
  },

  startFocus: async (mode, taskId = null) => {
    set({ focusState: await api.focus.start({ mode, taskId }) })
  },
  pauseFocus: async () => set({ focusState: await api.focus.pause() }),
  resumeFocus: async () => set({ focusState: await api.focus.resume() }),
  stopFocus: async () => {
    set({ focusState: await api.focus.stop() })
    await get().refreshStats()
  },
  skipFocus: async () => {
    set({ focusState: await api.focus.skip() })
    await get().refreshStats()
  },

  updateSettings: async (input) => {
    const settings = await api.settings.update(input)
    set({ settings })
    await get().refreshStats()
    return settings
  },

  openLearning: async (taskId) => {
    set({ openLearningTaskId: taskId, drawerMode: null, selectedTaskId: null })
    const pack = (await api.learning.get(taskId)) ?? (await api.learning.ensure(taskId))
    set((state) => ({ learningPacks: { ...state.learningPacks, [taskId]: pack } }))
    return pack
  },

  closeLearning: () => set({ openLearningTaskId: null }),

  refreshLearning: async (taskId) => {
    const pack = await api.learning.get(taskId)
    set((state) => {
      const learningPacks = { ...state.learningPacks }
      if (pack) learningPacks[taskId] = pack
      else delete learningPacks[taskId]
      return { learningPacks }
    })
    return pack
  },

  generateLearning: async (taskId, sections) => {
    const pack = await api.learning.generate(taskId, { sections })
    set((state) => ({ learningPacks: { ...state.learningPacks, [taskId]: pack } }))
    return pack
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
    if (!syncRunPromise) {
      syncRunPromise = api.sync.run().then(async (syncState) => {
        set({ syncState, syncConflicts: await api.sync.listConflicts() })
        return syncState
      }).finally(() => {
        syncRunPromise = null
      })
    }
    return syncRunPromise
  },

  disconnectSync: async () => {
    await api.sync.disconnect()
    const [syncSettings, syncState] = await Promise.all([api.sync.getSettings(), api.sync.getState()])
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
}))
