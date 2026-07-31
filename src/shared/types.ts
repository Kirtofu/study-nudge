export type TaskStatus = 'open' | 'completed' | 'deleted'
export type Priority = 'none' | 'low' | 'medium' | 'high'
export type FocusMode = 'pomodoro' | 'stopwatch' | 'legacy'
export type FocusPhase = 'focus' | 'break'
export type FocusRunStatus = 'idle' | 'running' | 'paused'
export type ViewId = 'inbox' | 'today' | 'upcoming' | 'completed' | `list:${string}`

export interface Tag {
  id: string
  name: string
  color: string
}

export interface Task {
  id: string
  title: string
  notes: string
  listId: string
  parentId: string | null
  status: TaskStatus
  scheduledFor: string | null
  dueAt: string | null
  reminderAt: string | null
  priority: Priority
  estimateMinutes: number | null
  position: number
  completedAt: string | null
  deletedAt: string | null
  createdAt: string
  updatedAt: string
  tags: Tag[]
  subtasks: Task[]
}

export interface TaskList {
  id: string
  name: string
  color: string
  position: number
  createdAt: string
  updatedAt: string
}

export interface FocusSession {
  id: string
  taskId: string | null
  mode: FocusMode
  startedAt: string
  endedAt: string
  durationSeconds: number
  note: string
  source: string
  sourceKey: string | null
}

export interface FocusState {
  status: FocusRunStatus
  mode: Exclude<FocusMode, 'legacy'>
  phase: FocusPhase
  taskId: string | null
  startedAt: string | null
  accumulatedSeconds: number
  durationSeconds: number | null
}

export interface FocusStats {
  todaySeconds: number
  totalSeconds: number
  streakDays: number
  dailyGoalMinutes: number
  longTermGoalHours: number
  longTermGoalLabel: string
  sessions: FocusSession[]
}

export interface AppSettings {
  dailyGoalMinutes: number
  longTermGoalHours: number
  longTermGoalLabel: string
  pomodoroFocusMinutes: number
  pomodoroBreakMinutes: number
  autoStart: boolean
  closeToTray: boolean
  globalShortcut: string
}

export interface CreateTaskInput {
  title: string
  notes?: string
  listId?: string
  parentId?: string | null
  scheduledFor?: string | null
  dueAt?: string | null
  reminderAt?: string | null
  priority?: Priority
  estimateMinutes?: number | null
  tagNames?: string[]
}

export interface UpdateTaskInput extends Partial<Omit<CreateTaskInput, 'title'>> {
  title?: string
  status?: TaskStatus
}

export interface BackupResult {
  canceled: boolean
  path?: string
  imported?: number
}

export interface NudgeBridge {
  tasks: {
    list: () => Promise<Task[]>
    create: (input: CreateTaskInput) => Promise<Task>
    update: (id: string, input: UpdateTaskInput) => Promise<Task>
    complete: (id: string, completed: boolean) => Promise<Task>
    delete: (id: string) => Promise<void>
    restore: (id: string) => Promise<Task>
    reorder: (ids: string[]) => Promise<void>
  }
  lists: {
    list: () => Promise<TaskList[]>
    create: (name: string) => Promise<TaskList>
    update: (id: string, input: { name?: string; color?: string }) => Promise<TaskList>
    delete: (id: string) => Promise<void>
  }
  tags: {
    list: () => Promise<Tag[]>
  }
  focus: {
    getState: () => Promise<FocusState>
    getStats: () => Promise<FocusStats>
    start: (input: { mode: 'pomodoro' | 'stopwatch'; taskId?: string | null }) => Promise<FocusState>
    pause: () => Promise<FocusState>
    resume: () => Promise<FocusState>
    stop: () => Promise<FocusState>
    skip: () => Promise<FocusState>
    onChange: (callback: (state: FocusState) => void) => () => void
  }
  settings: {
    get: () => Promise<AppSettings>
    update: (input: Partial<AppSettings>) => Promise<AppSettings>
  }
  backup: {
    exportJson: () => Promise<BackupResult>
    importJson: (mode: 'merge' | 'replace') => Promise<BackupResult>
  }
  desktop: {
    toggleMiniWindow: () => Promise<void>
    showMainWindow: () => Promise<void>
    onQuickAdd: (callback: () => void) => () => void
  }
}
