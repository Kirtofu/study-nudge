export type TaskStatus = 'open' | 'completed' | 'deleted'
export type Priority = 'none' | 'low' | 'medium' | 'high'
export type FocusMode = 'pomodoro' | 'stopwatch' | 'legacy'
export type FocusPhase = 'focus' | 'break'
export type FocusRunStatus = 'idle' | 'running' | 'paused'
export type ViewId = 'inbox' | 'today' | 'upcoming' | 'completed' | `list:${string}`
export type LearningPackStatus = 'empty' | 'generating' | 'ready' | 'partial' | 'error'
export type LearningResourceKind = 'document' | 'tool' | 'video'
export type LearningResourceSource = 'local-template' | 'ai' | 'user' | 'metadata'
export type LearningNodeStatus = 'pending' | 'active' | 'completed'
export type LearningNodeKind = 'goal' | 'concept' | 'practice' | 'project' | 'review' | 'custom'
export type LearningSection = 'resources' | 'videos' | 'roadmap'
export type RecommendationProvider = 'offline' | 'openai-compatible' | 'ollama'
export type SyncRunStatus = 'disconnected' | 'idle' | 'syncing' | 'offline' | 'error' | 'conflict'

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

export interface FocusHistoryQuery {
  range?: '7d' | '30d' | 'all'
  cursor?: string | null
  limit?: number
}

export interface FocusHistoryPage {
  items: FocusSession[]
  nextCursor: string | null
  total: number
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

export interface LearningPack {
  id: string
  taskId: string
  status: LearningPackStatus
  provider: RecommendationProvider
  model: string | null
  generationId: string | null
  completedSections: LearningSection[]
  failedSections: LearningSection[]
  createdAt: string
  updatedAt: string
  resources: LearningResource[]
  nodes: LearningNode[]
  edges: LearningEdge[]
}

export interface LearningResource {
  id: string
  packId: string
  taskId: string
  kind: LearningResourceKind
  title: string
  summary: string
  url: string
  platform: string
  language: string
  thumbnailUrl: string | null
  pinned: boolean
  verified: boolean
  source: LearningResourceSource
  position: number
  createdAt: string
  updatedAt: string
}

export interface LearningNode {
  id: string
  packId: string
  taskId: string
  kind: LearningNodeKind
  title: string
  description: string
  estimatedMinutes: number | null
  status: LearningNodeStatus
  x: number
  y: number
  position: number
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface LearningEdge {
  id: string
  packId: string
  sourceNodeId: string
  targetNodeId: string
  relation: 'depends-on'
  createdAt: string
}

export interface LearningProgressEvent {
  taskId: string
  packId: string
  generationId: string
  section: LearningSection
  state: 'queued' | 'generating' | 'success' | 'error' | 'canceled'
  message: string
}

export interface RecommendationSettings {
  provider: RecommendationProvider
  endpoint: string
  model: string
  networkEnabled: boolean
  sendNotes: boolean
  hasApiKey: boolean
}

export interface UpdateRecommendationSettingsInput
  extends Partial<Omit<RecommendationSettings, 'hasApiKey'>> {
  apiKey?: string
  clearApiKey?: boolean
}

export interface SyncSettings {
  enabled: boolean
  serverUrl: string
  username: string
  remotePath: string
  rememberPassphrase: boolean
  syncV3Confirmed: boolean
  hasCredentials: boolean
  deviceId: string
  deviceName: string
}

export interface SyncState {
  status: SyncRunStatus
  lastSyncedAt: string | null
  lastError: string | null
  pendingChanges: number
  conflictCount: number
  remoteEtag: string | null
}

export interface SyncConflict {
  id: string
  entityType: string
  entityId: string
  localPayload: unknown
  remotePayload: unknown
  createdAt: string
  resolvedAt: string | null
}

export interface ConfigureSyncInput {
  serverUrl: string
  username: string
  password: string
  passphrase: string
  remotePath?: string
  rememberPassphrase?: boolean
  deviceName?: string
}

export interface SecretStoreStatus {
  available: boolean
  backend: string
  migration: 'pending' | 'completed' | 'not-needed' | 'unknown'
  detail: string | null
}

export type NudgeErrorCode =
  | 'validation'
  | 'auth'
  | 'offline'
  | 'conflict'
  | 'secret-store'
  | 'canceled'
  | 'internal'

export interface BootstrapSnapshot {
  tasks: Task[]
  lists: TaskList[]
  tags: Tag[]
  settings: AppSettings
  focusState: FocusState
  focusStats: FocusStats
  recommendationSettings: RecommendationSettings
  syncSettings: SyncSettings
  syncState: SyncState
  syncConflicts: SyncConflict[]
  secretStore: SecretStoreStatus
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

export interface EntityChangeSet {
  upsertedTasks: Task[]
  removedTaskIds: string[]
  upsertedTags: Tag[]
}

export interface TaskMutationResult {
  task: Task | null
  changes: EntityChangeSet
}

export interface TaskOrderPatch {
  id: string
  position: number
}

export interface BackupResult {
  canceled: boolean
  path?: string
  imported?: number
}

export type DataDomain =
  | 'tasks'
  | 'tags'
  | 'lists'
  | 'settings'
  | 'focus'
  | 'learning'
  | 'recommendation'
  | 'sync'
export interface DataChangedEvent {
  domains: DataDomain[]
  source: 'local' | 'sync' | 'import'
}

export interface NudgeBridge {
  app: {
    bootstrap: () => Promise<BootstrapSnapshot>
    onDataChanged: (callback: (event: DataChangedEvent) => void) => () => void
  }
  tasks: {
    list: () => Promise<Task[]>
    create: (input: CreateTaskInput) => Promise<TaskMutationResult>
    update: (id: string, input: UpdateTaskInput) => Promise<TaskMutationResult>
    complete: (id: string, completed: boolean) => Promise<TaskMutationResult>
    delete: (id: string) => Promise<TaskMutationResult>
    restore: (id: string) => Promise<TaskMutationResult>
    reorder: (ids: string[]) => Promise<TaskOrderPatch[]>
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
    history: (query: FocusHistoryQuery) => Promise<FocusHistoryPage>
    start: (input: {
      mode: 'pomodoro' | 'stopwatch'
      taskId?: string | null
      replaceActive?: boolean
    }) => Promise<FocusState>
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
  learning: {
    get: (taskId: string) => Promise<LearningPack | null>
    ensure: (taskId: string) => Promise<LearningPack>
    generate: (
      taskId: string,
      input?: { sections?: LearningSection[]; includeNotes?: boolean }
    ) => Promise<LearningPack>
    cancel: (taskId: string) => Promise<void>
    resources: {
      create: (
        taskId: string,
        input: Pick<
          LearningResource,
          'kind' | 'title' | 'summary' | 'url' | 'platform' | 'language'
        >
      ) => Promise<LearningResource>
      update: (
        id: string,
        input: Partial<
          Pick<
            LearningResource,
            | 'kind'
            | 'title'
            | 'summary'
            | 'url'
            | 'platform'
            | 'language'
            | 'thumbnailUrl'
            | 'verified'
          >
        >
      ) => Promise<LearningResource>
      delete: (id: string) => Promise<void>
      reorder: (packId: string, ids: string[]) => Promise<void>
      pin: (id: string, pinned: boolean) => Promise<LearningResource>
    }
    roadmap: {
      upsertNode: (
        taskId: string,
        input: Partial<LearningNode> & Pick<LearningNode, 'title'>
      ) => Promise<LearningNode>
      deleteNode: (id: string) => Promise<void>
      connect: (packId: string, sourceNodeId: string, targetNodeId: string) => Promise<LearningEdge>
      disconnect: (id: string) => Promise<void>
      autoLayout: (taskId: string) => Promise<LearningPack>
      setStatus: (id: string, status: LearningNodeStatus) => Promise<LearningNode>
    }
    onProgress: (callback: (progress: LearningProgressEvent) => void) => () => void
  }
  recommendation: {
    getSettings: () => Promise<RecommendationSettings>
    updateSettings: (input: UpdateRecommendationSettingsInput) => Promise<RecommendationSettings>
    testConnection: (
      input?: UpdateRecommendationSettingsInput
    ) => Promise<{ ok: boolean; message: string }>
  }
  sync: {
    configure: (input: ConfigureSyncInput) => Promise<SyncSettings>
    test: (input?: ConfigureSyncInput) => Promise<{ ok: boolean; message: string }>
    run: () => Promise<SyncState>
    disconnect: () => Promise<void>
    getSettings: () => Promise<SyncSettings>
    confirmUpgrade: () => Promise<SyncSettings>
    getState: () => Promise<SyncState>
    listConflicts: () => Promise<SyncConflict[]>
    resolveConflict: (id: string, choice: 'local' | 'remote' | 'keep-both') => Promise<void>
    onStateChanged: (callback: (state: SyncState) => void) => () => void
  }
  secrets: {
    status: () => Promise<SecretStoreStatus>
    migrateLegacy: () => Promise<SecretStoreStatus>
  }
  backup: {
    exportJson: () => Promise<BackupResult>
    importJson: (mode: 'merge' | 'replace') => Promise<BackupResult>
  }
  media: {
    thumbnailDataUrl: (source: string) => Promise<string>
  }
  desktop: {
    toggleMiniWindow: () => Promise<void>
    showMainWindow: () => Promise<void>
    openExternal: (url: string) => Promise<void>
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<void>
    close: () => Promise<void>
    platform: () => Promise<'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'>
    prepareNotifications: () => Promise<boolean>
    onQuickAdd: (callback: () => void) => () => void
  }
}
