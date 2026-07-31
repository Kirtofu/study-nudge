import { addDays, format } from 'date-fns'
import type {
  AppSettings,
  CreateTaskInput,
  FocusSession,
  FocusState,
  FocusStats,
  NudgeBridge,
  Tag,
  Task,
  TaskList,
  UpdateTaskInput
} from '@shared/types'

const today = format(new Date(), 'yyyy-MM-dd')
const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
const timestamp = new Date().toISOString()

const demoTags: Tag[] = [
  { id: 'tag-start', name: '开始', color: '#c96442' },
  { id: 'tag-focus', name: '专注', color: '#247a48' }
]

let demoLists: TaskList[] = [
  { id: 'inbox', name: '收集箱', color: '#c96442', position: 0, createdAt: timestamp, updatedAt: timestamp },
  { id: 'personal', name: '个人', color: '#9a681b', position: 1, createdAt: timestamp, updatedAt: timestamp },
  { id: 'study', name: '学习', color: '#247a48', position: 2, createdAt: timestamp, updatedAt: timestamp },
  { id: 'work', name: '工作', color: '#5d658c', position: 3, createdAt: timestamp, updatedAt: timestamp }
]

let demoTasks: Task[] = [
  {
    id: 'demo-1',
    title: '把第一件事记下来',
    notes: '按 Ctrl+N，或直接使用上方的快速添加。',
    listId: 'personal',
    parentId: null,
    status: 'open',
    scheduledFor: today,
    dueAt: new Date(new Date().setHours(10, 30, 0, 0)).toISOString(),
    reminderAt: null,
    priority: 'medium',
    estimateMinutes: 10,
    position: 1000,
    completedAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: [demoTags[0]],
    subtasks: []
  },
  {
    id: 'demo-2',
    title: '拖动任务调整今天的顺序',
    notes: '拖住左侧的手柄，松开时会出现明确落点。',
    listId: 'personal',
    parentId: null,
    status: 'open',
    scheduledFor: today,
    dueAt: null,
    reminderAt: null,
    priority: 'none',
    estimateMinutes: 5,
    position: 2000,
    completedAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: [],
    subtasks: []
  },
  {
    id: 'demo-3',
    title: '开始一次 25 分钟专注',
    notes: '点击任务右侧的计时按钮，专注记录会自动关联到任务。',
    listId: 'study',
    parentId: null,
    status: 'open',
    scheduledFor: today,
    dueAt: new Date(new Date().setHours(15, 0, 0, 0)).toISOString(),
    reminderAt: null,
    priority: 'high',
    estimateMinutes: 25,
    position: 3000,
    completedAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: [demoTags[1]],
    subtasks: []
  },
  {
    id: 'demo-4',
    title: '整理明天的阅读清单',
    notes: '',
    listId: 'study',
    parentId: null,
    status: 'open',
    scheduledFor: tomorrow,
    dueAt: null,
    reminderAt: null,
    priority: 'low',
    estimateMinutes: 20,
    position: 4000,
    completedAt: null,
    deletedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    tags: [],
    subtasks: []
  }
]

let demoSettings: AppSettings = {
  dailyGoalMinutes: 120,
  longTermGoalHours: 350,
  longTermGoalLabel: '学习进度',
  pomodoroFocusMinutes: 25,
  pomodoroBreakMinutes: 5,
  autoStart: false,
  closeToTray: true,
  globalShortcut: 'Ctrl+Alt+Space'
}

let demoFocus: FocusState = {
  status: 'idle',
  mode: 'pomodoro',
  phase: 'focus',
  taskId: null,
  startedAt: null,
  accumulatedSeconds: 0,
  durationSeconds: null
}
const focusListeners = new Set<(state: FocusState) => void>()

function clone<T>(value: T): T {
  return structuredClone(value)
}

function findTask(id: string): Task {
  const flat = demoTasks.flatMap((task) => [task, ...task.subtasks])
  const task = flat.find((item) => item.id === id)
  if (!task) throw new Error('找不到任务')
  return task
}

function notifyFocus(): void {
  for (const listener of focusListeners) listener(clone(demoFocus))
}

function createDemoBridge(): NudgeBridge {
  return {
    tasks: {
      list: async () => clone(demoTasks.filter((task) => task.status !== 'deleted')),
      create: async (input: CreateTaskInput) => {
        const task: Task = {
          id: crypto.randomUUID(),
          title: input.title.trim(),
          notes: input.notes ?? '',
          listId: input.listId ?? 'inbox',
          parentId: input.parentId ?? null,
          status: 'open',
          scheduledFor: input.scheduledFor ?? null,
          dueAt: input.dueAt ?? null,
          reminderAt: input.reminderAt ?? null,
          priority: input.priority ?? 'none',
          estimateMinutes: input.estimateMinutes ?? null,
          position: Date.now(),
          completedAt: null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: (input.tagNames ?? []).map((name, index) => ({
            id: crypto.randomUUID(),
            name,
            color: ['#c96442', '#247a48', '#5d658c'][index % 3]
          })),
          subtasks: []
        }
        if (task.parentId) findTask(task.parentId).subtasks.push(task)
        else demoTasks.push(task)
        return clone(task)
      },
      update: async (id: string, input: UpdateTaskInput) => {
        const task = findTask(id)
        Object.assign(task, input, { updatedAt: new Date().toISOString() })
        if (input.tagNames) {
          task.tags = input.tagNames.map((name, index) => ({
            id: crypto.randomUUID(),
            name,
            color: ['#c96442', '#247a48', '#5d658c'][index % 3]
          }))
        }
        return clone(task)
      },
      complete: async (id: string, completed: boolean) => {
        const task = findTask(id)
        task.status = completed ? 'completed' : 'open'
        task.completedAt = completed ? new Date().toISOString() : null
        return clone(task)
      },
      delete: async (id: string) => {
        const task = findTask(id)
        task.status = 'deleted'
        task.deletedAt = new Date().toISOString()
      },
      restore: async (id: string) => {
        const task = findTask(id)
        task.status = 'open'
        task.deletedAt = null
        return clone(task)
      },
      reorder: async (ids: string[]) => {
        const positions = new Map(ids.map((id, index) => [id, index]))
        demoTasks.sort((a, b) => (positions.get(a.id) ?? 999) - (positions.get(b.id) ?? 999))
      }
    },
    lists: {
      list: async () => clone(demoLists),
      create: async (name: string) => {
        const list: TaskList = {
          id: crypto.randomUUID(),
          name,
          color: '#8c5d79',
          position: demoLists.length,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
        demoLists.push(list)
        return clone(list)
      },
      update: async (id, input) => {
        const list = demoLists.find((item) => item.id === id)
        if (!list) throw new Error('找不到清单')
        Object.assign(list, input, { updatedAt: new Date().toISOString() })
        return clone(list)
      },
      delete: async (id) => {
        demoLists = demoLists.filter((item) => item.id !== id)
      }
    },
    tags: { list: async () => clone(demoTags) },
    focus: {
      getState: async () => clone(demoFocus),
      getStats: async (): Promise<FocusStats> => ({
        todaySeconds: 5400,
        totalSeconds: 7200,
        streakDays: 1,
        dailyGoalMinutes: demoSettings.dailyGoalMinutes,
        longTermGoalHours: demoSettings.longTermGoalHours,
        longTermGoalLabel: demoSettings.longTermGoalLabel,
        sessions: [] as FocusSession[]
      }),
      start: async ({ mode, taskId }) => {
        demoFocus = {
          status: 'running',
          mode,
          phase: 'focus',
          taskId: taskId ?? null,
          startedAt: new Date().toISOString(),
          accumulatedSeconds: 0,
          durationSeconds: mode === 'pomodoro' ? demoSettings.pomodoroFocusMinutes * 60 : null
        }
        notifyFocus()
        return clone(demoFocus)
      },
      pause: async () => {
        demoFocus.status = 'paused'
        demoFocus.startedAt = null
        notifyFocus()
        return clone(demoFocus)
      },
      resume: async () => {
        demoFocus.status = 'running'
        demoFocus.startedAt = new Date().toISOString()
        notifyFocus()
        return clone(demoFocus)
      },
      stop: async () => {
        demoFocus = { ...demoFocus, status: 'idle', startedAt: null, accumulatedSeconds: 0 }
        notifyFocus()
        return clone(demoFocus)
      },
      skip: async () => {
        demoFocus = { ...demoFocus, status: 'idle', startedAt: null, accumulatedSeconds: 0 }
        notifyFocus()
        return clone(demoFocus)
      },
      onChange: (callback) => {
        focusListeners.add(callback)
        return () => focusListeners.delete(callback)
      }
    },
    settings: {
      get: async () => clone(demoSettings),
      update: async (input) => {
        demoSettings = { ...demoSettings, ...input }
        return clone(demoSettings)
      }
    },
    backup: {
      exportJson: async () => ({ canceled: false, path: 'nudge-demo-backup.json' }),
      importJson: async () => ({ canceled: false, imported: demoTasks.length })
    },
    desktop: {
      toggleMiniWindow: async () => undefined,
      showMainWindow: async () => undefined,
      onQuickAdd: () => () => undefined
    }
  }
}

const electronApi =
  typeof window === 'undefined' ? undefined : (window as Window & { nudge?: NudgeBridge }).nudge

export const api: NudgeBridge = electronApi ?? createDemoBridge()
