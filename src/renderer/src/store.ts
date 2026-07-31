import { create } from 'zustand'
import type {
  AppSettings,
  CreateTaskInput,
  FocusState,
  FocusStats,
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
  currentView: ViewId
  search: string
  selectedTaskId: string | null
  drawerMode: DrawerMode
  commandOpen: boolean
  initialize: () => Promise<void>
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
}

let focusUnsubscribe: (() => void) | null = null

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
  currentView: 'today',
  search: '',
  selectedTaskId: null,
  drawerMode: null,
  commandOpen: false,

  initialize: async () => {
    if (get().initialized || get().loading) return
    set({ loading: true, error: null })
    try {
      const [tasks, lists, tags, settings, focusState, focusStats] = await Promise.all([
        api.tasks.list(),
        api.lists.list(),
        api.tags.list(),
        api.settings.get(),
        api.focus.getState(),
        api.focus.getStats()
      ])
      focusUnsubscribe?.()
      focusUnsubscribe = api.focus.onChange((state) => {
        set({ focusState: state })
        void get().refreshStats()
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
        focusStats
      })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : '本地数据没有打开成功'
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

  setView: (currentView) => set({ currentView, selectedTaskId: null, drawerMode: null }),
  setSearch: (search) => set({ search }),
  selectTask: (selectedTaskId) =>
    set({ selectedTaskId, drawerMode: selectedTaskId ? 'task' : null }),
  openSettings: () => set({ drawerMode: 'settings', selectedTaskId: null }),
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
  }
}))
