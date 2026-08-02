import { addDays, format } from 'date-fns'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { appDataDir, join } from '@tauri-apps/api/path'
import { open, save } from '@tauri-apps/plugin-dialog'
import { Stronghold, type Client, type Store } from '@tauri-apps/plugin-stronghold'
import type {
  AppSettings,
  ConfigureSyncInput,
  CreateTaskInput,
  FocusSession,
  FocusState,
  FocusStats,
  LearningEdge,
  LearningNode,
  LearningPack,
  LearningProgressEvent,
  LearningResource,
  LearningSection,
  NudgeBridge,
  RecommendationSettings,
  SyncConflict,
  SyncSettings,
  SyncState,
  Tag,
  Task,
  TaskList,
  UpdateRecommendationSettingsInput,
  UpdateTaskInput
} from '@shared/types'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

const isTauri = typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const vaultPassword = 'Nudge::local-stronghold::v2'
const vaultClient = 'nudge-secrets-v2'
const SECRET_API_KEY = 'recommendation-api-key'
const SECRET_WEBDAV_PASSWORD = 'webdav-password'
const SECRET_SYNC_PASSPHRASE = 'sync-passphrase'
let strongholdPromise: Promise<{ stronghold: Stronghold; client: Client; store: Store }> | null = null
let sessionSyncPassphrase = ''

const LOCAL_CHANGE_COMMANDS = new Set([
  'tasks_create', 'tasks_update', 'tasks_complete', 'tasks_delete', 'tasks_restore', 'tasks_reorder',
  'lists_create', 'lists_update', 'lists_delete', 'focus_stop', 'focus_skip', 'backup_import',
  'learning_ensure', 'learning_generate', 'learning_resource_create', 'learning_resource_update',
  'learning_resource_delete', 'learning_resource_reorder', 'learning_resource_pin',
  'learning_node_upsert', 'learning_node_delete', 'learning_edge_connect',
  'learning_edge_disconnect', 'learning_auto_layout', 'learning_node_set_status',
  'sync_resolve_conflict'
])

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    const result = await invoke<T>(command, args)
    if (LOCAL_CHANGE_COMMANDS.has(command)) {
      window.dispatchEvent(new Event('nudge-local-change'))
    }
    return result
  } catch (error) {
    if (error instanceof Error) throw error
    if (typeof error === 'string') throw new Error(error)
    throw new Error('本地命令没有执行成功')
  }
}

function subscribe<T>(eventName: string, callback: (payload: T) => void): () => void {
  let disposed = false
  let unlisten: UnlistenFn | null = null
  void listen<T>(eventName, (event) => callback(event.payload)).then((off) => {
    if (disposed) off()
    else unlisten = off
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

async function getSecretStore(): Promise<{ stronghold: Stronghold; client: Client; store: Store }> {
  if (!strongholdPromise) {
    strongholdPromise = (async () => {
      const path = await join(await appDataDir(), 'nudge-vault.hold')
      const stronghold = await Stronghold.load(path, vaultPassword)
      let client: Client
      try {
        client = await stronghold.loadClient(vaultClient)
      } catch {
        client = await stronghold.createClient(vaultClient)
      }
      return { stronghold, client, store: client.getStore() }
    })()
  }
  return strongholdPromise
}

async function readSecret(key: string): Promise<string> {
  const { store } = await getSecretStore()
  const value = await store.get(key)
  return value ? decoder.decode(value) : ''
}

async function writeSecret(key: string, value: string): Promise<void> {
  const { stronghold, store } = await getSecretStore()
  if (value) await store.insert(key, Array.from(encoder.encode(value)))
  else await store.remove(key)
  await stronghold.save()
}

async function secretExists(key: string): Promise<boolean> {
  return Boolean(await readSecret(key))
}

function createTauriBridge(): NudgeBridge {
  return {
    tasks: {
      list: () => call('tasks_list'),
      create: (input) => call('tasks_create', { input }),
      update: (id, input) => call('tasks_update', { id, input }),
      complete: (id, completed) => call('tasks_complete', { id, completed }),
      delete: (id) => call('tasks_delete', { id }),
      restore: (id) => call('tasks_restore', { id }),
      reorder: (ids) => call('tasks_reorder', { ids })
    },
    lists: {
      list: () => call('lists_list'),
      create: (name) => call('lists_create', { name }),
      update: (id, input) => call('lists_update', { id, name: input.name, color: input.color }),
      delete: (id) => call('lists_delete', { id })
    },
    tags: { list: () => call('tags_list') },
    focus: {
      getState: () => call('focus_get_state'),
      getStats: () => call('focus_get_stats'),
      start: ({ mode, taskId }) => call('focus_start', { mode, taskId: taskId ?? null }),
      pause: () => call('focus_pause'),
      resume: () => call('focus_resume'),
      stop: () => call('focus_stop'),
      skip: () => call('focus_skip'),
      onChange: (callback) => subscribe('focus-changed', callback)
    },
    settings: {
      get: () => call('settings_get'),
      update: (input) => call('settings_update', { input })
    },
    learning: {
      get: (taskId) => call('learning_get', { taskId }),
      ensure: (taskId) => call('learning_ensure', { taskId }),
      generate: async (taskId, input = {}) => {
        const apiKey = await readSecret(SECRET_API_KEY)
        return call('learning_generate', {
          taskId,
          sections: input.sections ?? null,
          includeNotes: input.includeNotes ?? false,
          apiKey: apiKey || null
        })
      },
      cancel: (taskId) => call('learning_cancel', { taskId }),
      resources: {
        create: (taskId, input) => call('learning_resource_create', { taskId, input }),
        update: (id, input) => call('learning_resource_update', { id, input }),
        delete: (id) => call('learning_resource_delete', { id }),
        reorder: (packId, ids) => call('learning_resource_reorder', { packId, ids }),
        pin: (id, pinned) => call('learning_resource_pin', { id, pinned })
      },
      roadmap: {
        upsertNode: (taskId, input) => call('learning_node_upsert', { taskId, input }),
        deleteNode: (id) => call('learning_node_delete', { id }),
        connect: (packId, sourceNodeId, targetNodeId) =>
          call('learning_edge_connect', { packId, sourceNodeId, targetNodeId }),
        disconnect: (id) => call('learning_edge_disconnect', { id }),
        autoLayout: (taskId) => call('learning_auto_layout', { taskId }),
        setStatus: (id, status) => call('learning_node_set_status', { id, status })
      },
      onProgress: (callback) => subscribe('learning-progress', callback)
    },
    recommendation: {
      getSettings: async () =>
        call('recommendation_get_settings', { hasApiKey: await secretExists(SECRET_API_KEY) }),
      updateSettings: async (input) => {
        if (input.clearApiKey) await writeSecret(SECRET_API_KEY, '')
        if (input.apiKey !== undefined) await writeSecret(SECRET_API_KEY, input.apiKey.trim())
        const sanitized = { ...input }
        delete sanitized.apiKey
        delete sanitized.clearApiKey
        return call('recommendation_update_settings', {
          input: sanitized,
          hasApiKey: await secretExists(SECRET_API_KEY)
        })
      },
      testConnection: async (input) => {
        const apiKey = input?.apiKey?.trim() || (await readSecret(SECRET_API_KEY))
        const sanitized = input ? { ...input } : undefined
        if (sanitized) {
          delete sanitized.apiKey
          delete sanitized.clearApiKey
        }
        return call('recommendation_test_connection', {
          input: sanitized ?? null,
          apiKey: apiKey || null
        })
      }
    },
    sync: {
      configure: async (input) => {
        const settings = await call<SyncSettings>('sync_configure', { input })
        await writeSecret(SECRET_WEBDAV_PASSWORD, input.password)
        sessionSyncPassphrase = input.passphrase
        await writeSecret(
          SECRET_SYNC_PASSPHRASE,
          input.rememberPassphrase ? input.passphrase : ''
        )
        return settings
      },
      test: async (input) => {
        const configuration = input ?? {
          ...(await call<SyncSettings>('sync_get_settings', { hasCredentials: true })),
          password: await readSecret(SECRET_WEBDAV_PASSWORD),
          passphrase: sessionSyncPassphrase || (await readSecret(SECRET_SYNC_PASSPHRASE))
        }
        return call('sync_test', { input: configuration })
      },
      run: async () => {
        const password = await readSecret(SECRET_WEBDAV_PASSWORD)
        const passphrase = sessionSyncPassphrase || (await readSecret(SECRET_SYNC_PASSPHRASE))
        if (!password) throw new Error('WebDAV 密码未保存，请重新配置同步')
        if (!passphrase) throw new Error('请输入同步口令后再同步')
        return call('sync_run', { password, passphrase })
      },
      disconnect: async () => {
        await Promise.all([
          writeSecret(SECRET_WEBDAV_PASSWORD, ''),
          writeSecret(SECRET_SYNC_PASSPHRASE, '')
        ])
        sessionSyncPassphrase = ''
        await call('sync_disconnect')
      },
      getSettings: async () =>
        call('sync_get_settings', {
          hasCredentials: await secretExists(SECRET_WEBDAV_PASSWORD)
        }),
      getState: () => call('sync_get_state'),
      listConflicts: () => call('sync_list_conflicts'),
      resolveConflict: (id, choice) => call('sync_resolve_conflict', { id, choice }),
      onStateChanged: (callback) => subscribe('sync-state-changed', callback)
    },
    backup: {
      exportJson: async () => {
        const path = await save({
          title: '导出 Nudge 备份',
          defaultPath: `nudge-backup-${format(new Date(), 'yyyy-MM-dd')}.json`,
          filters: [{ name: 'Nudge JSON 备份', extensions: ['json'] }]
        })
        if (!path) return { canceled: true }
        return call('backup_export', { path })
      },
      importJson: async (mode) => {
        const path = await open({
          title: mode === 'replace' ? '恢复 Nudge 备份' : '导入 Nudge 数据',
          multiple: false,
          filters: [{ name: 'Nudge JSON 备份', extensions: ['json'] }]
        })
        if (!path || Array.isArray(path)) return { canceled: true }
        return call('backup_import', { path, mode })
      }
    },
    desktop: {
      toggleMiniWindow: () => call('desktop_toggle_mini_window'),
      showMainWindow: () => call('desktop_show_main'),
      openExternal: (url) => call('desktop_open_external', { url }),
      minimize: () => call('desktop_minimize'),
      toggleMaximize: () => call('desktop_toggle_maximize'),
      close: () => call('desktop_close'),
      platform: () => call('desktop_platform'),
      prepareNotifications: () => call('notifications_prepare'),
      onQuickAdd: (callback) => subscribe('desktop-quick-add', callback)
    }
  }
}

const today = format(new Date(), 'yyyy-MM-dd')
const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
const timestamp = new Date().toISOString()
const demoTags: Tag[] = [
  { id: 'tag-start', name: '开始', color: '#c96442' },
  { id: 'tag-focus', name: '专注', color: '#247a48' },
  { id: 'tag-learn', name: '学习包', color: '#9a681b' }
]
let demoLists: TaskList[] = [
  { id: 'inbox', name: '收集箱', color: '#c96442', position: 0, createdAt: timestamp, updatedAt: timestamp },
  { id: 'personal', name: '个人', color: '#9a681b', position: 1, createdAt: timestamp, updatedAt: timestamp },
  { id: 'study', name: '学习', color: '#247a48', position: 2, createdAt: timestamp, updatedAt: timestamp },
  { id: 'work', name: '工作', color: '#5d658c', position: 3, createdAt: timestamp, updatedAt: timestamp }
]
let demoTasks: Task[] = [
  {
    id: 'demo-1', title: '把第一件事记下来', notes: '按 Ctrl+N，或直接使用上方的快速添加。',
    listId: 'personal', parentId: null, status: 'open', scheduledFor: today,
    dueAt: new Date(new Date().setHours(10, 30, 0, 0)).toISOString(), reminderAt: null,
    priority: 'medium', estimateMinutes: 10, position: 1000, completedAt: null, deletedAt: null,
    createdAt: timestamp, updatedAt: timestamp, tags: [demoTags[0]], subtasks: []
  },
  {
    id: 'demo-2', title: '用学习包规划 React 性能优化', notes: '打开学习包查看资料、视频与可编辑路线。',
    listId: 'study', parentId: null, status: 'open', scheduledFor: today, dueAt: null, reminderAt: null,
    priority: 'high', estimateMinutes: 90, position: 2000, completedAt: null, deletedAt: null,
    createdAt: timestamp, updatedAt: timestamp, tags: [demoTags[2]], subtasks: []
  },
  {
    id: 'demo-3', title: '开始一次 25 分钟专注', notes: '专注记录会自动关联到任务。',
    listId: 'study', parentId: null, status: 'open', scheduledFor: today,
    dueAt: new Date(new Date().setHours(15, 0, 0, 0)).toISOString(), reminderAt: null,
    priority: 'none', estimateMinutes: 25, position: 3000, completedAt: null, deletedAt: null,
    createdAt: timestamp, updatedAt: timestamp, tags: [demoTags[1]], subtasks: []
  },
  {
    id: 'demo-4', title: '整理明天的阅读清单', notes: '', listId: 'study', parentId: null,
    status: 'open', scheduledFor: tomorrow, dueAt: null, reminderAt: null, priority: 'low',
    estimateMinutes: 20, position: 4000, completedAt: null, deletedAt: null, createdAt: timestamp,
    updatedAt: timestamp, tags: [], subtasks: []
  }
]
let demoSettings: AppSettings = {
  dailyGoalMinutes: 120, longTermGoalHours: 350, longTermGoalLabel: '学习进度',
  pomodoroFocusMinutes: 25, pomodoroBreakMinutes: 5, autoStart: false,
  closeToTray: true, globalShortcut: 'Ctrl+Alt+Space'
}
let demoFocus: FocusState = {
  status: 'idle', mode: 'pomodoro', phase: 'focus', taskId: null,
  startedAt: null, accumulatedSeconds: 0, durationSeconds: null
}
let demoRecommendation: RecommendationSettings = {
  provider: 'offline', endpoint: 'https://api.openai.com/v1', model: 'gpt-4.1-mini',
  networkEnabled: false, sendNotes: false, hasApiKey: false
}
let demoSyncSettings: SyncSettings = {
  enabled: false, serverUrl: '', username: '', remotePath: 'Nudge/nudge-v2.enc',
  rememberPassphrase: false, hasCredentials: false, deviceId: 'demo-device', deviceName: '演示设备'
}
let demoSyncState: SyncState = {
  status: 'disconnected', lastSyncedAt: null, lastError: null,
  pendingChanges: 0, conflictCount: 0, remoteEtag: null
}
const focusListeners = new Set<(state: FocusState) => void>()
const learningListeners = new Set<(progress: LearningProgressEvent) => void>()
const syncListeners = new Set<(state: SyncState) => void>()
const demoPacks = new Map<string, LearningPack>()

function clone<T>(value: T): T { return structuredClone(value) }
function findTask(id: string): Task {
  const task = demoTasks.flatMap((item) => [item, ...item.subtasks]).find((item) => item.id === id)
  if (!task) throw new Error('找不到任务')
  return task
}
function emitFocus(): void { focusListeners.forEach((listener) => listener(clone(demoFocus))) }
function emitSync(): void { syncListeners.forEach((listener) => listener(clone(demoSyncState))) }

function ensureDemoPack(taskId: string): LearningPack {
  const existing = demoPacks.get(taskId)
  if (existing) return clone(existing)
  const task = findTask(taskId)
  const packId = crypto.randomUUID()
  const now = new Date().toISOString()
  const resources: LearningResource[] = [
    ['document', `查找“${task.title}”官方文档`, '优先阅读维护者发布的入门与概念文档。', `https://www.google.com/search?q=${encodeURIComponent(`${task.title} 官方 文档`)}`, 'Web'],
    ['tool', `寻找“${task.title}”练习工具`, '从可立即动手的沙盒与示例仓库开始。', `https://github.com/search?q=${encodeURIComponent(`${task.title} examples`)}`, 'GitHub'],
    ['video', `YouTube：${task.title}`, '搜索带章节和配套资料的完整课程。', `https://www.youtube.com/results?search_query=${encodeURIComponent(task.title)}`, 'YouTube'],
    ['video', `B站：${task.title}`, '搜索中文系列课程与实战项目。', `https://search.bilibili.com/all?keyword=${encodeURIComponent(task.title)}`, '哔哩哔哩']
  ].map(([kind, title, summary, url, platform], index) => ({
    id: crypto.randomUUID(), packId, taskId, kind: kind as LearningResource['kind'], title, summary,
    url, platform, language: 'zh-CN', thumbnailUrl: null, pinned: false, verified: false,
    source: 'local-template', position: (index + 1) * 1000, createdAt: now, updatedAt: now
  }))
  const stages = [
    ['goal', '明确目标', `定义完成“${task.title}”后要能独立做到什么。`, 20],
    ['concept', '基础概念', '梳理核心术语、原理与常见误区。', 60],
    ['practice', '跟练', '完成一个小而完整的示例。', 90],
    ['project', '独立实践', '脱离教程完成可验证的小作品。', 120],
    ['review', '复盘输出', '用笔记或讲解总结收获与下一步。', 30]
  ] as const
  const nodes: LearningNode[] = stages.map(([kind, title, description, estimatedMinutes], index) => ({
    id: crypto.randomUUID(), packId, taskId, kind, title, description, estimatedMinutes,
    status: 'pending', x: 36 + index * 30, y: 32 + index * 132, position: (index + 1) * 1000,
    pinned: false, createdAt: now, updatedAt: now
  }))
  const edges: LearningEdge[] = nodes.slice(1).map((node, index) => ({
    id: crypto.randomUUID(), packId, sourceNodeId: nodes[index].id,
    targetNodeId: node.id, relation: 'depends-on', createdAt: now
  }))
  const pack: LearningPack = {
    id: packId, taskId, status: 'ready', provider: 'offline', model: null, generationId: null,
    completedSections: ['resources', 'videos', 'roadmap'], failedSections: [],
    createdAt: now, updatedAt: now, resources, nodes, edges
  }
  demoPacks.set(taskId, pack)
  return clone(pack)
}

function createDemoBridge(): NudgeBridge {
  const refreshPack = (taskId: string): LearningPack => clone(demoPacks.get(taskId) ?? ensureDemoPack(taskId))
  return {
    tasks: {
      list: async () => clone(demoTasks.filter((task) => task.status !== 'deleted')),
      create: async (input: CreateTaskInput) => {
        const task: Task = {
          id: crypto.randomUUID(), title: input.title.trim(), notes: input.notes ?? '', listId: input.listId ?? 'inbox',
          parentId: input.parentId ?? null, status: 'open', scheduledFor: input.scheduledFor ?? null,
          dueAt: input.dueAt ?? null, reminderAt: input.reminderAt ?? null, priority: input.priority ?? 'none',
          estimateMinutes: input.estimateMinutes ?? null, position: Date.now(), completedAt: null, deletedAt: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          tags: (input.tagNames ?? []).map((name, index) => ({ id: crypto.randomUUID(), name, color: [ACCENT, '#247a48', '#5d658c'][index % 3] })), subtasks: []
        }
        if (task.parentId) findTask(task.parentId).subtasks.push(task); else demoTasks.push(task)
        return clone(task)
      },
      update: async (id: string, input: UpdateTaskInput) => {
        const task = findTask(id); Object.assign(task, input, { updatedAt: new Date().toISOString() })
        if (input.tagNames) task.tags = input.tagNames.map((name) => ({ id: crypto.randomUUID(), name, color: ACCENT }))
        return clone(task)
      },
      complete: async (id, completed) => { const task = findTask(id); task.status = completed ? 'completed' : 'open'; task.completedAt = completed ? new Date().toISOString() : null; return clone(task) },
      delete: async (id) => { const task = findTask(id); task.status = 'deleted'; task.deletedAt = new Date().toISOString() },
      restore: async (id) => { const task = findTask(id); task.status = 'open'; task.deletedAt = null; return clone(task) },
      reorder: async (ids) => { const positions = new Map(ids.map((id, index) => [id, index])); demoTasks.sort((a, b) => (positions.get(a.id) ?? 999) - (positions.get(b.id) ?? 999)) }
    },
    lists: {
      list: async () => clone(demoLists),
      create: async (name) => { const list = { id: crypto.randomUUID(), name, color: '#8c5d79', position: demoLists.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; demoLists.push(list); return clone(list) },
      update: async (id, input) => { const list = demoLists.find((item) => item.id === id); if (!list) throw new Error('找不到清单'); Object.assign(list, input, { updatedAt: new Date().toISOString() }); return clone(list) },
      delete: async (id) => { demoLists = demoLists.filter((item) => item.id !== id) }
    },
    tags: { list: async () => clone(demoTags) },
    focus: {
      getState: async () => clone(demoFocus),
      getStats: async (): Promise<FocusStats> => ({ todaySeconds: 5400, totalSeconds: 7200, streakDays: 1, dailyGoalMinutes: demoSettings.dailyGoalMinutes, longTermGoalHours: demoSettings.longTermGoalHours, longTermGoalLabel: demoSettings.longTermGoalLabel, sessions: [] as FocusSession[] }),
      start: async ({ mode, taskId }) => { demoFocus = { status: 'running', mode, phase: 'focus', taskId: taskId ?? null, startedAt: new Date().toISOString(), accumulatedSeconds: 0, durationSeconds: mode === 'pomodoro' ? demoSettings.pomodoroFocusMinutes * 60 : null }; emitFocus(); return clone(demoFocus) },
      pause: async () => { demoFocus.status = 'paused'; demoFocus.startedAt = null; emitFocus(); return clone(demoFocus) },
      resume: async () => { demoFocus.status = 'running'; demoFocus.startedAt = new Date().toISOString(); emitFocus(); return clone(demoFocus) },
      stop: async () => { demoFocus = { ...demoFocus, status: 'idle', startedAt: null, accumulatedSeconds: 0 }; emitFocus(); return clone(demoFocus) },
      skip: async () => { demoFocus = { ...demoFocus, status: 'idle', startedAt: null, accumulatedSeconds: 0 }; emitFocus(); return clone(demoFocus) },
      onChange: (callback) => { focusListeners.add(callback); return () => focusListeners.delete(callback) }
    },
    settings: { get: async () => clone(demoSettings), update: async (input) => { demoSettings = { ...demoSettings, ...input }; return clone(demoSettings) } },
    learning: {
      get: async (taskId) => clone(demoPacks.get(taskId) ?? null),
      ensure: async (taskId) => ensureDemoPack(taskId),
      generate: async (taskId, input) => {
        const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId)
        const generationId = crypto.randomUUID(); pack.status = 'generating'; pack.generationId = generationId
        for (const section of input?.sections ?? ['resources', 'videos', 'roadmap'] as LearningSection[]) {
          learningListeners.forEach((listener) => listener({ taskId, packId: pack.id, generationId, section, state: 'generating', message: '正在生成' }))
          await new Promise((resolve) => setTimeout(resolve, 260))
          learningListeners.forEach((listener) => listener({ taskId, packId: pack.id, generationId, section, state: 'success', message: '这一栏已经更新' }))
        }
        pack.status = 'ready'; pack.provider = demoRecommendation.provider; pack.model = demoRecommendation.model
        return refreshPack(taskId)
      },
      cancel: async () => undefined,
      resources: {
        create: async (taskId, input) => { const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId); const now = new Date().toISOString(); const resource: LearningResource = { id: crypto.randomUUID(), packId: pack.id, taskId, ...input, thumbnailUrl: null, pinned: false, verified: false, source: 'user', position: (pack.resources.length + 1) * 1000, createdAt: now, updatedAt: now }; pack.resources.push(resource); return clone(resource) },
        update: async (id, input) => { const pack = [...demoPacks.values()].find((item) => item.resources.some((resource) => resource.id === id)); const resource = pack?.resources.find((item) => item.id === id); if (!resource) throw new Error('找不到资源'); Object.assign(resource, input, { updatedAt: new Date().toISOString() }); return clone(resource) },
        delete: async (id) => { for (const pack of demoPacks.values()) pack.resources = pack.resources.filter((resource) => resource.id !== id) },
        reorder: async (_packId, ids) => { for (const pack of demoPacks.values()) pack.resources.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) },
        pin: async (id, pinned) => { const resource = [...demoPacks.values()].flatMap((pack) => pack.resources).find((item) => item.id === id); if (!resource) throw new Error('找不到资源'); resource.pinned = pinned; return clone(resource) }
      },
      roadmap: {
        upsertNode: async (taskId, input) => { const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId); const existing = input.id ? pack.nodes.find((node) => node.id === input.id) : null; if (existing) { Object.assign(existing, input, { updatedAt: new Date().toISOString() }); return clone(existing) } const now = new Date().toISOString(); const node: LearningNode = { id: crypto.randomUUID(), packId: pack.id, taskId, kind: input.kind ?? 'custom', title: input.title, description: input.description ?? '', estimatedMinutes: input.estimatedMinutes ?? null, status: input.status ?? 'pending', x: input.x ?? 36, y: input.y ?? 36, position: input.position ?? (pack.nodes.length + 1) * 1000, pinned: input.pinned ?? false, createdAt: now, updatedAt: now }; pack.nodes.push(node); return clone(node) },
        deleteNode: async (id) => { for (const pack of demoPacks.values()) { pack.nodes = pack.nodes.filter((node) => node.id !== id); pack.edges = pack.edges.filter((edge) => edge.sourceNodeId !== id && edge.targetNodeId !== id) } },
        connect: async (packId, sourceNodeId, targetNodeId) => { const pack = [...demoPacks.values()].find((item) => item.id === packId); if (!pack) throw new Error('找不到学习包'); const edge: LearningEdge = { id: crypto.randomUUID(), packId, sourceNodeId, targetNodeId, relation: 'depends-on', createdAt: new Date().toISOString() }; pack.edges.push(edge); return clone(edge) },
        disconnect: async (id) => { for (const pack of demoPacks.values()) pack.edges = pack.edges.filter((edge) => edge.id !== id) },
        autoLayout: async (taskId) => { const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId); pack.nodes.forEach((node, index) => { node.x = 36; node.y = 32 + index * 132 }); return refreshPack(taskId) },
        setStatus: async (id, status) => { const node = [...demoPacks.values()].flatMap((pack) => pack.nodes).find((item) => item.id === id); if (!node) throw new Error('找不到节点'); node.status = status; return clone(node) }
      },
      onProgress: (callback) => { learningListeners.add(callback); return () => learningListeners.delete(callback) }
    },
    recommendation: {
      getSettings: async () => clone(demoRecommendation),
      updateSettings: async (input) => { demoRecommendation = { ...demoRecommendation, ...input, hasApiKey: Boolean(input.apiKey) || demoRecommendation.hasApiKey }; return clone(demoRecommendation) },
      testConnection: async () => ({ ok: true, message: demoRecommendation.provider === 'offline' ? '离线模板无需连接。' : '演示连接成功。' })
    },
    sync: {
      configure: async (input: ConfigureSyncInput) => { demoSyncSettings = { ...demoSyncSettings, enabled: true, serverUrl: input.serverUrl, username: input.username, remotePath: input.remotePath ?? demoSyncSettings.remotePath, rememberPassphrase: input.rememberPassphrase ?? false, hasCredentials: true, deviceName: input.deviceName || demoSyncSettings.deviceName }; demoSyncState.status = 'idle'; return clone(demoSyncSettings) },
      test: async () => ({ ok: true, message: '演示 WebDAV 连接成功。' }),
      run: async () => { demoSyncState = { ...demoSyncState, status: 'syncing' }; emitSync(); await new Promise((resolve) => setTimeout(resolve, 500)); demoSyncState = { ...demoSyncState, status: 'idle', lastSyncedAt: new Date().toISOString(), pendingChanges: 0 }; emitSync(); return clone(demoSyncState) },
      disconnect: async () => { demoSyncSettings.enabled = false; demoSyncState = { ...demoSyncState, status: 'disconnected' }; emitSync() },
      getSettings: async () => clone(demoSyncSettings), getState: async () => clone(demoSyncState),
      listConflicts: async () => [] as SyncConflict[], resolveConflict: async () => undefined,
      onStateChanged: (callback) => { syncListeners.add(callback); return () => syncListeners.delete(callback) }
    },
    backup: { exportJson: async () => ({ canceled: false, path: 'nudge-v2-demo-backup.json' }), importJson: async () => ({ canceled: false, imported: demoTasks.length }) },
    desktop: { toggleMiniWindow: async () => undefined, showMainWindow: async () => undefined, openExternal: async (url) => { window.open(url, '_blank', 'noopener,noreferrer') }, minimize: async () => undefined, toggleMaximize: async () => undefined, close: async () => undefined, platform: async () => 'unknown', prepareNotifications: async () => true, onQuickAdd: () => () => undefined }
  }
}

const ACCENT = '#c96442'
export const api: NudgeBridge = isTauri ? createTauriBridge() : createDemoBridge()
