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
  SecretStoreStatus,
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

type DrawerMode = 'task' | 'settings' | 'focus-history' | null

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
  secretStore: SecretStoreStatus | null
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
  openFocusHistory: () => void
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

function removeTaskFromTree(tasks: Task[], id: string): Task[] {
  return tasks
    .filter((task) => task.id !== id)
    .map((task) => ({ ...task, subtasks: removeTaskFromTree(task.subtasks, id) }))
}

function insertTaskIntoTree(tasks: Task[], task: Task): Task[] {
  const withoutTask = removeTaskFromTree(tasks, task.id)
  if (!task.parentId) return [...withoutTask, task].sort((a, b) => a.position - b.position)

  let inserted = false
  const visit = (items: Task[]): Task[] => items.map((item) => {
    if (item.id === task.parentId) {
      inserted = true
      return {
        ...item,
        subtasks: [...removeTaskFromTree(item.subtasks, task.id), task].sort((a, b) => a.position - b.position)
      }
    }
    return { ...item, subtasks: visit(item.subtasks) }
  })
  const next = visit(withoutTask)
  return inserted ? next : withoutTask
}

function patchTaskTree(tasks: Task[], id: string, patch: Partial<Task>): Task[] {
  return tasks.map((task) => task.id === id
    ? { ...task, ...patch }
    : { ...task, subtasks: patchTaskTree(task.subtasks, id, patch) })
}

function mergeTaskTags(tags: Tag[], task: Task): Tag[] {
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  task.tags.forEach((tag) => byId.set(tag.id, tag))
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function scheduleAutomaticSync(delay = 5_000): void {
  if (automaticSyncTimer) clearTimeout(automaticSyncTimer)
  automaticSyncTimer = setTimeout(() => {
    automaticSyncTimer = null
    const state = useNudgeStore.getState()
    if (
      !state.initialized ||
      !state.syncSettings?.enabled ||
      !state.syncSettings.rememberPassphrase ||
      !state.syncSettings.syncV3Confirmed ||
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
  secretStore: null,
  currentView: 'today',
  search: '',
  selectedTaskId: null,
  drawerMode: null,
  commandOpen: false,

  initialize: async () => {
    if (get().initialized || get().loading) return
    set({ loading: true, error: null })
    try {
      const snapshot = await api.app.bootstrap()
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
        ...snapshot
      })
      installSyncLifecycle()
      if (snapshot.syncSettings.enabled && snapshot.syncSettings.rememberPassphrase) scheduleAutomaticSync(750)
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
      const snapshot = await api.app.bootstrap()
      focusUnsubscribe?.()
      focusUnsubscribe = api.focus.onChange((state) => set({ focusState: state }))
      set({
        initialized: true,
        loading: false,
        error: null,
        tasks: snapshot.tasks,
        settings: snapshot.settings,
        focusState: snapshot.focusState
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
  openFocusHistory: () => set({ drawerMode: 'focus-history', selectedTaskId: null, openLearningTaskId: null }),
  closeDrawer: () => set({ drawerMode: null, selectedTaskId: null }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),

  createTask: async (input) => {
    const result = await api.tasks.create(input)
    const task = result.task
    if (!task) throw new Error('新任务没有返回有效内容')
    set((state) => ({
      tasks: insertTaskIntoTree(state.tasks, task),
      tags: mergeTaskTags(state.tags, task)
    }))
    set({ selectedTaskId: task.parentId ? get().selectedTaskId : task.id, drawerMode: 'task' })
    return task
  },

  updateTask: async (id, input) => {
    const snapshot = get().tasks
    const optimistic: Partial<Task> = {
      ...input,
      updatedAt: new Date().toISOString()
    }
    delete (optimistic as Partial<Task> & { tagNames?: string[] }).tagNames
    set({ tasks: patchTaskTree(snapshot, id, optimistic) })
    try {
      const result = await api.tasks.update(id, input)
      const task = result.task
      if (!task) throw new Error('任务更新没有返回有效内容')
      set((state) => ({
        tasks: insertTaskIntoTree(state.tasks, task),
        tags: mergeTaskTags(state.tags, task)
      }))
      return task
    } catch (error) {
      set({ tasks: snapshot })
      throw error
    }
  },

  completeTask: async (id, completed) => {
    const snapshot = get().tasks
    set({
      tasks: patchTaskTree(snapshot, id, {
        status: completed ? 'completed' : 'open',
        completedAt: completed ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString()
      })
    })
    try {
      const result = await api.tasks.complete(id, completed)
      const task = result.task
      if (!task) throw new Error('任务状态没有返回有效内容')
      set((state) => ({ tasks: insertTaskIntoTree(state.tasks, task) }))
      return task
    } catch (error) {
      set({ tasks: snapshot })
      throw error
    }
  },

  deleteTask: async (id) => {
    const snapshot = get().tasks
    set({ tasks: removeTaskFromTree(snapshot, id) })
    try {
      await api.tasks.delete(id)
      if (get().selectedTaskId === id) set({ selectedTaskId: null, drawerMode: null })
    } catch (error) {
      set({ tasks: snapshot })
      throw error
    }
  },

  restoreTask: async (id) => {
    const result = await api.tasks.restore(id)
    const task = result.task
    if (!task) throw new Error('恢复任务没有返回有效内容')
    set((state) => ({ tasks: insertTaskIntoTree(state.tasks, task) }))
    return task
  },

  reorderTasks: async (ids) => {
    const snapshot = get().tasks
    const position = new Map(ids.map((id, index) => [id, index]))
    set({
      tasks: [...get().tasks].sort(
        (a, b) => (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      )
    })
    try {
      await api.tasks.reorder(ids)
    } catch (error) {
      set({ tasks: snapshot })
      throw error
    }
  },

  createList: async (name) => {
    const list = await api.lists.create(name)
    set((state) => ({ lists: [...state.lists, list].sort((a, b) => a.position - b.position), currentView: `list:${list.id}` }))
    return list
  },

  updateList: async (id, input) => {
    const list = await api.lists.update(id, input)
    set((state) => ({ lists: state.lists.map((item) => item.id === id ? list : item) }))
    return list
  },

  deleteList: async (id) => {
    const snapshot = get()
    set({
      lists: snapshot.lists.filter((list) => list.id !== id),
      tasks: snapshot.tasks.map((task) => task.listId === id ? { ...task, listId: 'inbox' } : task),
      currentView: 'inbox'
    })
    try {
      await api.lists.delete(id)
    } catch (error) {
      set({ lists: snapshot.lists, tasks: snapshot.tasks, currentView: snapshot.currentView })
      throw error
    }
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
    const currentSettings = get().syncSettings
    if (currentSettings?.enabled && !currentSettings.syncV3Confirmed) {
      const confirmed = window.confirm(
        'Nudge v2.1 将把远端同步文件升级为 schema 3。连接同一远端文件的其他设备也需要升级到 v2.1；继续后 v2.0 将停止同步。是否继续？'
      )
      if (!confirmed) throw new Error('已取消同步格式升级')
      set({ syncSettings: await api.sync.confirmUpgrade() })
    }
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
