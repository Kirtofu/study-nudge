import type {
  AppSettings,
  BootstrapSnapshot,
  ConfigureSyncInput,
  CreateTaskInput,
  DataChangedEvent,
  DataDomain,
  FocusHistoryPage,
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
  SecretStoreStatus,
  SyncConflict,
  SyncSettings,
  SyncState,
  Tag,
  Task,
  TaskList,
  UpdateTaskInput
} from '@shared/types'
import { addDays, format } from 'date-fns'
import { flattenTasks, reorderSlots, taskMap, taskTree } from '../features/tasks/model'

export function createDemoBridge(): NudgeBridge {
  const ACCENT = '#c96442'
  const today = format(new Date(), 'yyyy-MM-dd')
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')
  const timestamp = new Date().toISOString()
  const demoTags: Tag[] = [
    { id: 'tag-start', name: '开始', color: '#c96442' },
    { id: 'tag-focus', name: '专注', color: '#247a48' },
    { id: 'tag-learn', name: '学习包', color: '#9a681b' }
  ]
  let demoLists: TaskList[] = [
    {
      id: 'inbox',
      name: '收集箱',
      color: '#c96442',
      position: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: 'personal',
      name: '个人',
      color: '#9a681b',
      position: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: 'study',
      name: '学习',
      color: '#247a48',
      position: 2,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: 'work',
      name: '工作',
      color: '#5d658c',
      position: 3,
      createdAt: timestamp,
      updatedAt: timestamp
    }
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
      title: '用学习包规划 React 性能优化',
      notes: '打开学习包查看资料、视频与可编辑路线。',
      listId: 'study',
      parentId: null,
      status: 'open',
      scheduledFor: today,
      dueAt: null,
      reminderAt: null,
      priority: 'high',
      estimateMinutes: 90,
      position: 2000,
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: [demoTags[2]],
      subtasks: []
    },
    {
      id: 'demo-3',
      title: '开始一次 25 分钟专注',
      notes: '专注记录会自动关联到任务。',
      listId: 'study',
      parentId: null,
      status: 'open',
      scheduledFor: today,
      dueAt: new Date(new Date().setHours(15, 0, 0, 0)).toISOString(),
      reminderAt: null,
      priority: 'none',
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
  let demoRecommendation: RecommendationSettings = {
    provider: 'offline',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    networkEnabled: false,
    sendNotes: false,
    hasApiKey: false
  }
  let demoSyncSettings: SyncSettings = {
    enabled: false,
    serverUrl: '',
    username: '',
    remotePath: 'Nudge/nudge-v2.enc',
    rememberPassphrase: false,
    syncV3Confirmed: true,
    hasCredentials: false,
    deviceId: 'demo-device',
    deviceName: '演示设备'
  }
  let demoSyncState: SyncState = {
    status: 'disconnected',
    lastSyncedAt: null,
    lastError: null,
    pendingChanges: 0,
    conflictCount: 0,
    remoteEtag: null
  }
  const focusListeners = new Set<(state: FocusState) => void>()
  const learningListeners = new Set<(progress: LearningProgressEvent) => void>()
  const syncListeners = new Set<(state: SyncState) => void>()
  const demoPacks = new Map<string, LearningPack>()
  const demoSecretStatus: SecretStoreStatus = {
    available: true,
    backend: 'demo-system-keyring',
    migration: 'not-needed',
    detail: null
  }

  function clone<T>(value: T): T {
    return structuredClone(value)
  }
  function findTask(id: string): Task {
    const task = flattenTasks(demoTasks).find((item) => item.id === id)
    if (!task) throw new Error('找不到任务')
    return task
  }
  function emitFocus(): void {
    focusListeners.forEach((listener) => listener(clone(demoFocus)))
  }
  function emitSync(): void {
    syncListeners.forEach((listener) => listener(clone(demoSyncState)))
  }

  function ensureDemoPack(taskId: string): LearningPack {
    const existing = demoPacks.get(taskId)
    if (existing) return clone(existing)
    const task = findTask(taskId)
    const packId = crypto.randomUUID()
    const now = new Date().toISOString()
    const resources: LearningResource[] = [
      [
        'document',
        `查找“${task.title}”官方文档`,
        '优先阅读维护者发布的入门与概念文档。',
        `https://www.google.com/search?q=${encodeURIComponent(`${task.title} 官方 文档`)}`,
        'Web'
      ],
      [
        'tool',
        `寻找“${task.title}”练习工具`,
        '从可立即动手的沙盒与示例仓库开始。',
        `https://github.com/search?q=${encodeURIComponent(`${task.title} examples`)}`,
        'GitHub'
      ],
      [
        'video',
        `YouTube：${task.title}`,
        '搜索带章节和配套资料的完整课程。',
        `https://www.youtube.com/results?search_query=${encodeURIComponent(task.title)}`,
        'YouTube'
      ],
      [
        'video',
        `B站：${task.title}`,
        '搜索中文系列课程与实战项目。',
        `https://search.bilibili.com/all?keyword=${encodeURIComponent(task.title)}`,
        '哔哩哔哩'
      ]
    ].map(([kind, title, summary, url, platform], index) => ({
      id: crypto.randomUUID(),
      packId,
      taskId,
      kind: kind as LearningResource['kind'],
      title,
      summary,
      url,
      platform,
      language: 'zh-CN',
      thumbnailUrl: null,
      pinned: false,
      verified: false,
      source: 'local-template',
      position: (index + 1) * 1000,
      createdAt: now,
      updatedAt: now
    }))
    const stages = [
      ['goal', '明确目标', `定义完成“${task.title}”后要能独立做到什么。`, 20],
      ['concept', '基础概念', '梳理核心术语、原理与常见误区。', 60],
      ['practice', '跟练', '完成一个小而完整的示例。', 90],
      ['project', '独立实践', '脱离教程完成可验证的小作品。', 120],
      ['review', '复盘输出', '用笔记或讲解总结收获与下一步。', 30]
    ] as const
    const nodes: LearningNode[] = stages.map(
      ([kind, title, description, estimatedMinutes], index) => ({
        id: crypto.randomUUID(),
        packId,
        taskId,
        kind,
        title,
        description,
        estimatedMinutes,
        status: 'pending',
        x: 36 + index * 30,
        y: 32 + index * 132,
        position: (index + 1) * 1000,
        pinned: false,
        createdAt: now,
        updatedAt: now
      })
    )
    const edges: LearningEdge[] = nodes.slice(1).map((node, index) => ({
      id: crypto.randomUUID(),
      packId,
      sourceNodeId: nodes[index].id,
      targetNodeId: node.id,
      relation: 'depends-on',
      createdAt: now
    }))
    const pack: LearningPack = {
      id: packId,
      taskId,
      status: 'ready',
      provider: 'offline',
      model: null,
      generationId: null,
      completedSections: ['resources', 'videos', 'roadmap'],
      failedSections: [],
      createdAt: now,
      updatedAt: now,
      resources,
      nodes,
      edges
    }
    demoPacks.set(taskId, pack)
    return clone(pack)
  }

  const dataListeners = new Set<(event: DataChangedEvent) => void>()
  let lastDeletion = 0
  let focusTimer: ReturnType<typeof setInterval> | undefined
  let demoSessions: FocusSession[] = []
  const elapsed = (): number =>
    demoFocus.accumulatedSeconds +
    (demoFocus.status === 'running' && demoFocus.startedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(demoFocus.startedAt)) / 1000))
      : 0)
  const breakState = (): FocusState => ({
    status: 'running',
    mode: 'pomodoro',
    phase: 'break',
    taskId: null,
    startedAt: new Date().toISOString(),
    accumulatedSeconds: 0,
    durationSeconds: demoSettings.pomodoroBreakMinutes * 60
  })
  function saveSession(): void {
    const seconds = Math.min(elapsed(), demoFocus.durationSeconds ?? Infinity)
    if (demoFocus.status === 'idle' || demoFocus.phase !== 'focus' || seconds < 1) return
    demoSessions.push({
      id: crypto.randomUUID(),
      taskId: demoFocus.taskId,
      mode: demoFocus.mode,
      startedAt: new Date(Date.now() - seconds * 1000).toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: seconds,
      note: demoFocus.taskId ? findTask(demoFocus.taskId).title : '自由专注',
      source: 'demo',
      sourceKey: null
    })
  }
  function persist(): void {
    try {
      sessionStorage.setItem(
        'nudge-preview-v2.2',
        JSON.stringify({
          tasks: demoTasks,
          lists: demoLists,
          settings: demoSettings,
          focus: demoFocus,
          sessions: demoSessions,
          packs: [...demoPacks]
        })
      )
    } catch {
      /* Preview storage may be unavailable. */
    }
  }
  function tick(): void {
    if (
      demoFocus.status !== 'running' ||
      demoFocus.durationSeconds === null ||
      elapsed() < demoFocus.durationSeconds
    )
      return
    const wasFocus = demoFocus.phase === 'focus'
    if (wasFocus) saveSession()
    demoFocus = wasFocus
      ? breakState()
      : { ...demoFocus, status: 'idle', startedAt: null, accumulatedSeconds: 0 }
    persist()
    emitFocus()
    dataListeners.forEach((listener) => listener({ domains: ['focus'], source: 'local' }))
  }
  function tagsFor(names: string[]): Tag[] {
    return [...new Set(names.map((name) => name.trim()).filter(Boolean))]
      .slice(0, 8)
      .map((name) => {
        const existing = demoTags.find(
          (tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase()
        )
        if (existing) return existing
        const tag = { id: crypto.randomUUID(), name, color: ACCENT }
        demoTags.push(tag)
        return tag
      })
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem('nudge-preview-v2.2') || 'null')
    if (saved && Array.isArray(saved.tasks)) {
      demoTasks = saved.tasks
      demoLists = saved.lists
      demoSettings = saved.settings
      demoFocus = saved.focus
      demoSessions = saved.sessions ?? []
      for (const [id, pack] of saved.packs ?? []) demoPacks.set(id, pack)
    }
  } catch {
    /* Keep the preview usable if its temporary storage was cleared. */
  }
  const refreshPack = (taskId: string): LearningPack =>
    clone(demoPacks.get(taskId) ?? ensureDemoPack(taskId))
  const focusStats = (): FocusStats => ({
    todaySeconds:
      5400 +
      demoSessions
        .filter(
          (session) =>
            format(new Date(session.startedAt), 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')
        )
        .reduce((sum, session) => sum + session.durationSeconds, 0),
    totalSeconds: 7200 + demoSessions.reduce((sum, session) => sum + session.durationSeconds, 0),
    streakDays: 1,
    dailyGoalMinutes: demoSettings.dailyGoalMinutes,
    longTermGoalHours: demoSettings.longTermGoalHours,
    longTermGoalLabel: demoSettings.longTermGoalLabel,
    sessions: clone(demoSessions).reverse()
  })
  const bridge: NudgeBridge = {
    app: {
      bootstrap: async (): Promise<BootstrapSnapshot> => ({
        tasks: taskTree(taskMap(clone(demoTasks))),
        lists: clone(demoLists),
        tags: clone(demoTags),
        settings: clone(demoSettings),
        focusState: clone(demoFocus),
        focusStats: focusStats(),
        recommendationSettings: clone(demoRecommendation),
        syncSettings: clone(demoSyncSettings),
        syncState: clone(demoSyncState),
        syncConflicts: [],
        secretStore: clone(demoSecretStatus)
      }),
      onDataChanged: (callback) => {
        dataListeners.add(callback)
        return () => dataListeners.delete(callback)
      }
    },
    tasks: {
      list: async () => taskTree(taskMap(clone(demoTasks))),
      create: async (input: CreateTaskInput) => {
        if (!input.title.trim()) throw new Error('请输入任务标题')
        if (input.parentId) findTask(input.parentId)
        const position =
          Math.max(
            0,
            ...flattenTasks(demoTasks)
              .filter((task) => task.parentId === (input.parentId ?? null))
              .map((task) => task.position)
          ) + 1000
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
          position,
          completedAt: null,
          deletedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tags: tagsFor(input.tagNames ?? []),
          subtasks: []
        }
        if (task.parentId) findTask(task.parentId).subtasks.push(task)
        else demoTasks.push(task)
        return {
          task: clone(task),
          changes: {
            upsertedTasks: [clone(task)],
            removedTaskIds: [],
            upsertedTags: clone(task.tags)
          }
        }
      },
      update: async (id: string, input: UpdateTaskInput) => {
        if (input.title !== undefined && !input.title.trim()) throw new Error('任务标题不能为空')
        const task = findTask(id)
        Object.assign(task, input, { updatedAt: new Date().toISOString() })
        if (input.tagNames) task.tags = tagsFor(input.tagNames)
        return {
          task: clone(task),
          changes: {
            upsertedTasks: [clone(task)],
            removedTaskIds: [],
            upsertedTags: clone(task.tags)
          }
        }
      },
      complete: async (id, completed) => {
        const task = findTask(id)
        task.status = completed ? 'completed' : 'open'
        task.completedAt = completed ? new Date().toISOString() : null
        return {
          task: clone(task),
          changes: {
            upsertedTasks: [clone(task)],
            removedTaskIds: [],
            upsertedTags: clone(task.tags)
          }
        }
      },
      delete: async (id) => {
        lastDeletion = Math.max(Date.now(), lastDeletion + 1)
        const stamp = new Date(lastDeletion).toISOString()
        const removedTaskIds: string[] = []
        const remove = (task: Task): void => {
          if (task.status === 'deleted') return
          removedTaskIds.push(task.id)
          task.status = 'deleted'
          task.deletedAt = stamp
          task.subtasks.forEach(remove)
        }
        remove(findTask(id))
        return { task: null, changes: { upsertedTasks: [], removedTaskIds, upsertedTags: [] } }
      },
      restore: async (id) => {
        const task = findTask(id)
        const stamp = task.deletedAt
        const restore = (item: Task): void => {
          if (item.deletedAt !== stamp) return
          item.status = item.completedAt ? 'completed' : 'open'
          item.deletedAt = null
          item.subtasks.forEach(restore)
        }
        restore(task)
        const restored = taskTree(taskMap([task]))[0] ?? task
        return {
          task: clone(restored),
          changes: {
            upsertedTasks: [clone(restored)],
            removedTaskIds: [],
            upsertedTags: clone(task.tags)
          }
        }
      },
      reorder: async (ids) => {
        const patches = reorderSlots(demoTasks, ids)
        for (const patch of patches) findTask(patch.id).position = patch.position
        return patches
      }
    },
    lists: {
      list: async () => clone(demoLists),
      create: async (name) => {
        const list = {
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
        flattenTasks(demoTasks).forEach((task) => {
          if (task.listId === id) task.listId = 'inbox'
        })
      }
    },
    tags: { list: async () => clone(demoTags) },
    focus: {
      getState: async () => {
        tick()
        return clone(demoFocus)
      },
      getStats: async (): Promise<FocusStats> => focusStats(),
      history: async (query): Promise<FocusHistoryPage> => {
        const cutoff =
          query.range === 'all' ? 0 : Date.now() - (query.range === '30d' ? 30 : 7) * 86400000
        const items = demoSessions
          .filter((session) => Date.parse(session.startedAt) >= cutoff)
          .slice()
          .reverse()
        return { items, nextCursor: null, total: items.length }
      },
      start: async ({ mode, taskId = null, replaceActive = false }) => {
        if (taskId) findTask(taskId)
        if (demoFocus.status !== 'idle') {
          if (demoFocus.taskId === taskId && demoFocus.mode === mode && demoFocus.phase === 'focus')
            return clone(demoFocus)
          if (!replaceActive) throw new Error('已有专注正在进行，请先确认保存并切换')
          saveSession()
        }
        demoFocus = {
          status: 'running',
          mode,
          phase: 'focus',
          taskId,
          startedAt: new Date().toISOString(),
          accumulatedSeconds: 0,
          durationSeconds: mode === 'pomodoro' ? demoSettings.pomodoroFocusMinutes * 60 : null
        }
        emitFocus()
        return clone(demoFocus)
      },
      pause: async () => {
        if (demoFocus.status === 'running') {
          demoFocus.accumulatedSeconds = elapsed()
          demoFocus.status = 'paused'
          demoFocus.startedAt = null
        }
        emitFocus()
        return clone(demoFocus)
      },
      resume: async () => {
        if (demoFocus.status === 'paused') {
          demoFocus.status = 'running'
          demoFocus.startedAt = new Date().toISOString()
        }
        emitFocus()
        return clone(demoFocus)
      },
      stop: async () => {
        saveSession()
        demoFocus = { ...demoFocus, status: 'idle', startedAt: null, accumulatedSeconds: 0 }
        emitFocus()
        return clone(demoFocus)
      },
      skip: async () => {
        saveSession()
        demoFocus =
          demoFocus.mode === 'pomodoro' && demoFocus.phase === 'focus'
            ? breakState()
            : { ...demoFocus, status: 'idle', startedAt: null, accumulatedSeconds: 0 }
        emitFocus()
        return clone(demoFocus)
      },
      onChange: (callback) => {
        focusListeners.add(callback)
        focusTimer ??= setInterval(tick, 1000)
        return () => {
          focusListeners.delete(callback)
          if (!focusListeners.size) {
            clearInterval(focusTimer)
            focusTimer = undefined
          }
        }
      }
    },
    settings: {
      get: async () => clone(demoSettings),
      update: async (input) => {
        demoSettings = { ...demoSettings, ...input }
        return clone(demoSettings)
      }
    },
    learning: {
      get: async (taskId) => clone(demoPacks.get(taskId) ?? null),
      ensure: async (taskId) => ensureDemoPack(taskId),
      generate: async (taskId, input) => {
        const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId)
        const generationId = crypto.randomUUID()
        pack.status = 'generating'
        pack.generationId = generationId
        for (const section of input?.sections ??
          (['resources', 'videos', 'roadmap'] as LearningSection[])) {
          learningListeners.forEach((listener) =>
            listener({
              taskId,
              packId: pack.id,
              generationId,
              section,
              state: 'generating',
              message: '正在生成'
            })
          )
          await new Promise((resolve) => setTimeout(resolve, 260))
          learningListeners.forEach((listener) =>
            listener({
              taskId,
              packId: pack.id,
              generationId,
              section,
              state: 'success',
              message: '这一栏已经更新'
            })
          )
        }
        pack.status = 'ready'
        pack.provider = demoRecommendation.provider
        pack.model = demoRecommendation.model
        return refreshPack(taskId)
      },
      cancel: async () => undefined,
      resources: {
        create: async (taskId, input) => {
          const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId)
          const now = new Date().toISOString()
          const resource: LearningResource = {
            id: crypto.randomUUID(),
            packId: pack.id,
            taskId,
            ...input,
            thumbnailUrl: null,
            pinned: false,
            verified: false,
            source: 'user',
            position: (pack.resources.length + 1) * 1000,
            createdAt: now,
            updatedAt: now
          }
          pack.resources.push(resource)
          return clone(resource)
        },
        update: async (id, input) => {
          const pack = [...demoPacks.values()].find((item) =>
            item.resources.some((resource) => resource.id === id)
          )
          const resource = pack?.resources.find((item) => item.id === id)
          if (!resource) throw new Error('找不到资源')
          Object.assign(resource, input, { updatedAt: new Date().toISOString() })
          return clone(resource)
        },
        delete: async (id) => {
          for (const pack of demoPacks.values())
            pack.resources = pack.resources.filter((resource) => resource.id !== id)
        },
        reorder: async (_packId, ids) => {
          for (const pack of demoPacks.values())
            pack.resources.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        },
        pin: async (id, pinned) => {
          const resource = [...demoPacks.values()]
            .flatMap((pack) => pack.resources)
            .find((item) => item.id === id)
          if (!resource) throw new Error('找不到资源')
          resource.pinned = pinned
          return clone(resource)
        }
      },
      roadmap: {
        upsertNode: async (taskId, input) => {
          const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId)
          const existing = input.id ? pack.nodes.find((node) => node.id === input.id) : null
          if (existing) {
            Object.assign(existing, input, { updatedAt: new Date().toISOString() })
            return clone(existing)
          }
          const now = new Date().toISOString()
          const node: LearningNode = {
            id: crypto.randomUUID(),
            packId: pack.id,
            taskId,
            kind: input.kind ?? 'custom',
            title: input.title,
            description: input.description ?? '',
            estimatedMinutes: input.estimatedMinutes ?? null,
            status: input.status ?? 'pending',
            x: input.x ?? 36,
            y: input.y ?? 36,
            position: input.position ?? (pack.nodes.length + 1) * 1000,
            pinned: input.pinned ?? false,
            createdAt: now,
            updatedAt: now
          }
          pack.nodes.push(node)
          return clone(node)
        },
        deleteNode: async (id) => {
          for (const pack of demoPacks.values()) {
            pack.nodes = pack.nodes.filter((node) => node.id !== id)
            pack.edges = pack.edges.filter(
              (edge) => edge.sourceNodeId !== id && edge.targetNodeId !== id
            )
          }
        },
        connect: async (packId, sourceNodeId, targetNodeId) => {
          const pack = [...demoPacks.values()].find((item) => item.id === packId)
          if (!pack) throw new Error('找不到学习包')
          const edge: LearningEdge = {
            id: crypto.randomUUID(),
            packId,
            sourceNodeId,
            targetNodeId,
            relation: 'depends-on',
            createdAt: new Date().toISOString()
          }
          pack.edges.push(edge)
          return clone(edge)
        },
        disconnect: async (id) => {
          for (const pack of demoPacks.values())
            pack.edges = pack.edges.filter((edge) => edge.id !== id)
        },
        autoLayout: async (taskId) => {
          const pack = demoPacks.get(taskId) ?? ensureDemoPack(taskId)
          pack.nodes.forEach((node, index) => {
            node.x = 36
            node.y = 32 + index * 132
          })
          return refreshPack(taskId)
        },
        setStatus: async (id, status) => {
          const node = [...demoPacks.values()]
            .flatMap((pack) => pack.nodes)
            .find((item) => item.id === id)
          if (!node) throw new Error('找不到节点')
          node.status = status
          return clone(node)
        }
      },
      onProgress: (callback) => {
        learningListeners.add(callback)
        return () => learningListeners.delete(callback)
      }
    },
    recommendation: {
      getSettings: async () => clone(demoRecommendation),
      updateSettings: async ({ apiKey, clearApiKey, ...input }) => {
        demoRecommendation = {
          ...demoRecommendation,
          ...input,
          hasApiKey: clearApiKey ? false : Boolean(apiKey) || demoRecommendation.hasApiKey
        }
        return clone(demoRecommendation)
      },
      testConnection: async () => ({
        ok: true,
        message: demoRecommendation.provider === 'offline' ? '离线模板无需连接。' : '演示连接成功。'
      })
    },
    sync: {
      configure: async (input: ConfigureSyncInput) => {
        demoSyncSettings = {
          ...demoSyncSettings,
          enabled: true,
          serverUrl: input.serverUrl,
          username: input.username,
          remotePath: input.remotePath ?? demoSyncSettings.remotePath,
          rememberPassphrase: input.rememberPassphrase ?? false,
          hasCredentials: true,
          deviceName: input.deviceName || demoSyncSettings.deviceName
        }
        demoSyncState.status = 'idle'
        return clone(demoSyncSettings)
      },
      test: async () => ({ ok: true, message: '演示 WebDAV 连接成功。' }),
      run: async () => {
        demoSyncState = { ...demoSyncState, status: 'syncing' }
        emitSync()
        await new Promise((resolve) => setTimeout(resolve, 500))
        demoSyncState = {
          ...demoSyncState,
          status: 'idle',
          lastSyncedAt: new Date().toISOString(),
          pendingChanges: 0
        }
        emitSync()
        return clone(demoSyncState)
      },
      disconnect: async () => {
        demoSyncSettings.enabled = false
        demoSyncState = { ...demoSyncState, status: 'disconnected' }
        emitSync()
      },
      getSettings: async () => clone(demoSyncSettings),
      confirmUpgrade: async () => {
        demoSyncSettings.syncV3Confirmed = true
        return clone(demoSyncSettings)
      },
      getState: async () => clone(demoSyncState),
      listConflicts: async () => [] as SyncConflict[],
      resolveConflict: async () => undefined,
      onStateChanged: (callback) => {
        syncListeners.add(callback)
        return () => syncListeners.delete(callback)
      }
    },
    secrets: {
      status: async () => clone(demoSecretStatus),
      migrateLegacy: async () => clone(demoSecretStatus)
    },
    backup: {
      exportJson: async () => {
        throw new Error('请在桌面版导出本地备份；浏览器这里只提供交互预览。')
      },
      importJson: async () => {
        throw new Error('请在桌面版导入本地备份；浏览器这里只提供交互预览。')
      }
    },
    media: { thumbnailDataUrl: async () => '' },
    desktop: {
      toggleMiniWindow: async () => undefined,
      showMainWindow: async () => undefined,
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      close: async () => undefined,
      platform: async () => 'unknown',
      prepareNotifications: async () => true,
      onQuickAdd: () => () => undefined
    }
  }

  const mutationDomains: Record<string, DataDomain[]> = {
    tasks: ['tasks', 'tags'],
    lists: ['tasks', 'lists'],
    focus: ['focus'],
    settings: ['settings'],
    learning: ['learning'],
    recommendation: ['recommendation'],
    sync: ['sync', 'tasks', 'lists', 'learning'],
    backup: ['tasks', 'lists', 'focus']
  }
  const readonly = new Set([
    'list',
    'get',
    'getState',
    'getStats',
    'getSettings',
    'history',
    'test',
    'testConnection',
    'exportJson',
    'listConflicts'
  ])
  const wrap = (
    value: Record<string, unknown>,
    domains: DataDomain[],
    source: DataChangedEvent['source']
  ): void => {
    for (const [key, fn] of Object.entries(value)) {
      if (typeof fn === 'object' && fn) {
        wrap(fn as Record<string, unknown>, domains, source)
        continue
      }
      if (typeof fn !== 'function' || key.startsWith('on') || readonly.has(key)) continue
      value[key] = async (...args: unknown[]) => {
        const result = await fn(...args)
        persist()
        dataListeners.forEach((listener) => listener({ domains, source }))
        return result
      }
    }
  }
  for (const [domain, domains] of Object.entries(mutationDomains))
    wrap(
      bridge[domain as keyof NudgeBridge] as unknown as Record<string, unknown>,
      domains,
      domain === 'sync' ? 'sync' : domain === 'backup' ? 'import' : 'local'
    )
  return bridge
}
