import type {
  AppSettings,
  CreateTaskInput,
  DataDomain,
  FocusState,
  FocusStats,
  LearningPack,
  LearningProgressEvent,
  LearningSection,
  NudgeBridge,
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

type DrawerMode = 'task' | 'settings' | 'focus-history' | null

export interface NudgeStore {
  today: string
  backgroundError: string | null
  focusBusy: boolean
  focusError: string | null
  pendingFocus: { mode: 'pomodoro' | 'stopwatch'; taskId: string | null } | null
  confirmFocusSwitch: () => Promise<void>
  cancelFocusSwitch: () => void
  retryFocus: () => Promise<void>
  learningErrors: Record<string, string>
  refreshData: (domains?: DataDomain[]) => Promise<void>
  dispose: () => void
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
  updateRecommendationSettings: (
    input: Partial<RecommendationSettings> & { apiKey?: string; clearApiKey?: boolean }
  ) => Promise<RecommendationSettings>
  configureSync: (input: Parameters<NudgeBridge['sync']['configure']>[0]) => Promise<SyncSettings>
  runSync: () => Promise<SyncState>
  disconnectSync: () => Promise<void>
  refreshSync: () => Promise<void>
}

export type StoreSet = (
  value: Partial<NudgeStore> | ((state: NudgeStore) => Partial<NudgeStore>)
) => void
export type StoreGet = () => NudgeStore
