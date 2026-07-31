import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type {
  AppSettings,
  CreateTaskInput,
  FocusSession,
  FocusState,
  FocusStats,
  Tag,
  Task,
  TaskList,
  UpdateTaskInput
} from '../shared/types'

type DbTaskRow = {
  id: string
  list_id: string
  parent_id: string | null
  title: string
  notes: string
  status: Task['status']
  scheduled_for: string | null
  due_at: string | null
  reminder_at: string | null
  priority: Task['priority']
  estimate_minutes: number | null
  position: number
  completed_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type DbListRow = {
  id: string
  name: string
  color: string
  position: number
  created_at: string
  updated_at: string
}

type DbFocusRow = {
  id: string
  task_id: string | null
  mode: FocusSession['mode']
  started_at: string
  ended_at: string
  duration_seconds: number
  note: string
  source: string
  source_key: string | null
}

const DEFAULT_SETTINGS: AppSettings = {
  dailyGoalMinutes: 120,
  longTermGoalHours: 350,
  longTermGoalLabel: '学习进度',
  pomodoroFocusMinutes: 25,
  pomodoroBreakMinutes: 5,
  autoStart: false,
  closeToTray: true,
  globalShortcut: 'Ctrl+Alt+Space'
}

const EMPTY_FOCUS_STATE: FocusState = {
  status: 'idle',
  mode: 'pomodoro',
  phase: 'focus',
  taskId: null,
  startedAt: null,
  accumulatedSeconds: 0,
  durationSeconds: null
}

const nullableString = z.string().nullable()

const backupSchema = z.object({
  schemaVersion: z.number().int().positive().optional(),
  exportedAt: z.string().optional(),
  data: z.object({
    lists: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        color: z.string(),
        position: z.number(),
        is_system: z.number().int(),
        created_at: z.string(),
        updated_at: z.string()
      })
    ),
    tasks: z.array(
      z.object({
        id: z.string().min(1),
        list_id: z.string().min(1),
        parent_id: nullableString,
        title: z.string(),
        notes: z.string(),
        status: z.enum(['open', 'completed', 'deleted']),
        scheduled_for: nullableString,
        due_at: nullableString,
        reminder_at: nullableString,
        notified_at: nullableString,
        priority: z.enum(['none', 'low', 'medium', 'high']),
        estimate_minutes: z.number().nullable(),
        position: z.number(),
        completed_at: nullableString,
        deleted_at: nullableString,
        created_at: z.string(),
        updated_at: z.string()
      })
    ),
    tags: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string(),
          color: z.string(),
          created_at: z.string()
        })
      )
      .default([]),
    taskTags: z
      .array(
        z.object({
          task_id: z.string().min(1),
          tag_id: z.string().min(1)
        })
      )
      .default([]),
    focusSessions: z
      .array(
        z.object({
          id: z.string().min(1),
          task_id: nullableString,
          mode: z.enum(['pomodoro', 'stopwatch', 'legacy']),
          started_at: z.string(),
          ended_at: z.string(),
          duration_seconds: z.number().int().nonnegative(),
          note: z.string(),
          source: z.string(),
          source_key: nullableString
        })
      )
      .default([]),
    settings: z
      .array(
        z.object({
          key: z.string().min(1),
          value: z.string(),
          updated_at: z.string()
        })
      )
      .default([])
  })
})

type BackupRow = Record<string, string | number | null>

function nowIso(): string {
  return new Date().toISOString()
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function mapList(row: DbListRow): TaskList {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapFocus(row: DbFocusRow): FocusSession {
  return {
    id: row.id,
    taskId: row.task_id,
    mode: row.mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    note: row.note,
    source: row.source,
    sourceKey: row.source_key
  }
}

export class NudgeDatabase {
  private readonly db: DatabaseSync

  constructor(
    private readonly databasePath: string,
    private readonly legacyPaths: string[]
  ) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
    this.migrate()
    this.ensureDefaults()
    this.importLegacySessions()
    this.seedOnboardingTasks()
  }

  get path(): string {
    return this.databasePath
  }

  close(): void {
    this.db.close()
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(FULL)')
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE RESTRICT,
        parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        scheduled_for TEXT,
        due_at TEXT,
        reminder_at TEXT,
        notified_at TEXT,
        priority TEXT NOT NULL DEFAULT 'none',
        estimate_minutes INTEGER,
        position REAL NOT NULL DEFAULT 0,
        completed_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_schedule ON tasks(scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks(reminder_at, notified_at);

      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_tags (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY(task_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS focus_sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'nudge',
        source_key TEXT UNIQUE
      );

      CREATE INDEX IF NOT EXISTS idx_focus_started ON focus_sessions(started_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  }

  private ensureDefaults(): void {
    const timestamp = nowIso()
    const defaultLists = [
      { id: 'inbox', name: '收集箱', color: '#c96442', position: 0, system: 1 },
      { id: 'personal', name: '个人', color: '#9a681b', position: 1, system: 0 },
      { id: 'study', name: '学习', color: '#247a48', position: 2, system: 0 },
      { id: 'work', name: '工作', color: '#5d658c', position: 3, system: 0 }
    ]
    const insertList = this.db.prepare(`
      INSERT OR IGNORE INTO lists (id, name, color, position, is_system, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const list of defaultLists) {
      insertList.run(list.id, list.name, list.color, list.position, list.system, timestamp, timestamp)
    }

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this.setSettingIfMissing(key, value)
    }
    this.setSettingIfMissing('focusState', EMPTY_FOCUS_STATE)
    this.setSettingIfMissing('onboardingSeeded', false)
    this.setSettingIfMissing('lastBackupDate', '')
  }

  private seedOnboardingTasks(): void {
    if (this.getSetting<boolean>('onboardingSeeded', false)) return
    const existing = this.db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number }
    if (Number(existing.count) === 0) {
      const today = localDateKey()
      this.createTask({
        title: '把第一件事记下来',
        notes: '按 Ctrl+N，或直接使用上方的快速添加。',
        listId: 'personal',
        scheduledFor: today,
        priority: 'medium',
        estimateMinutes: 10,
        tagNames: ['开始']
      })
      this.createTask({
        title: '拖动任务调整今天的顺序',
        notes: '拖住任务左侧的手柄，松开时会出现明确落点。',
        listId: 'personal',
        scheduledFor: today,
        estimateMinutes: 5
      })
      this.createTask({
        title: '开始一次 25 分钟专注',
        notes: '点击任务右侧的计时按钮，专注记录会自动关联到任务。',
        listId: 'study',
        scheduledFor: today,
        priority: 'high',
        estimateMinutes: 25,
        tagNames: ['专注']
      })
    }
    this.setSetting('onboardingSeeded', true)
  }

  private setSettingIfMissing(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
    `).run(key, JSON.stringify(value), nowIso())
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), nowIso())
  }

  getSettings(): AppSettings {
    return {
      dailyGoalMinutes: this.getSetting('dailyGoalMinutes', DEFAULT_SETTINGS.dailyGoalMinutes),
      longTermGoalHours: this.getSetting('longTermGoalHours', DEFAULT_SETTINGS.longTermGoalHours),
      longTermGoalLabel: this.getSetting('longTermGoalLabel', DEFAULT_SETTINGS.longTermGoalLabel),
      pomodoroFocusMinutes: this.getSetting(
        'pomodoroFocusMinutes',
        DEFAULT_SETTINGS.pomodoroFocusMinutes
      ),
      pomodoroBreakMinutes: this.getSetting(
        'pomodoroBreakMinutes',
        DEFAULT_SETTINGS.pomodoroBreakMinutes
      ),
      autoStart: this.getSetting('autoStart', DEFAULT_SETTINGS.autoStart),
      closeToTray: this.getSetting('closeToTray', DEFAULT_SETTINGS.closeToTray),
      globalShortcut: this.getSetting('globalShortcut', DEFAULT_SETTINGS.globalShortcut)
    }
  }

  updateSettings(input: Partial<AppSettings>): AppSettings {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && key in DEFAULT_SETTINGS) this.setSetting(key, value)
    }
    return this.getSettings()
  }

  getFocusState(): FocusState {
    return this.getSetting<FocusState>('focusState', EMPTY_FOCUS_STATE)
  }

  setFocusState(state: FocusState): void {
    this.setSetting('focusState', state)
  }

  listLists(): TaskList[] {
    const rows = this.db
      .prepare(`SELECT id, name, color, position, created_at, updated_at FROM lists ORDER BY position, name`)
      .all() as unknown as DbListRow[]
    return rows.map(mapList)
  }

  createList(name: string): TaskList {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('清单名称不能为空')
    const id = randomUUID()
    const timestamp = nowIso()
    const count = this.listLists().length
    const colors = ['#c96442', '#247a48', '#5d658c', '#9a681b', '#8c5d79']
    this.db.prepare(`
      INSERT INTO lists (id, name, color, position, is_system, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(id, cleanName, colors[count % colors.length], count, timestamp, timestamp)
    return this.getList(id)
  }

  updateList(id: string, input: { name?: string; color?: string }): TaskList {
    const current = this.getList(id)
    const name = input.name?.trim() || current.name
    const color = input.color || current.color
    this.db.prepare(`UPDATE lists SET name = ?, color = ?, updated_at = ? WHERE id = ?`).run(
      name,
      color,
      nowIso(),
      id
    )
    return this.getList(id)
  }

  deleteList(id: string): void {
    if (id === 'inbox') throw new Error('收集箱不能删除')
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`UPDATE tasks SET list_id = 'inbox', updated_at = ? WHERE list_id = ?`).run(
        nowIso(),
        id
      )
      this.db.prepare(`DELETE FROM lists WHERE id = ?`).run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private getList(id: string): TaskList {
    const row = this.db
      .prepare(`SELECT id, name, color, position, created_at, updated_at FROM lists WHERE id = ?`)
      .get(id) as DbListRow | undefined
    if (!row) throw new Error('找不到该清单')
    return mapList(row)
  }

  listTags(): Tag[] {
    return this.db
      .prepare(`SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE`)
      .all() as unknown as Tag[]
  }

  listTasks(): Task[] {
    return this.buildTaskMap(false).roots
  }

  getTask(id: string): Task {
    const result = this.buildTaskMap(true).map.get(id)
    if (!result) throw new Error('找不到该任务')
    return result
  }

  private buildTaskMap(includeDeleted: boolean): { roots: Task[]; map: Map<string, Task> } {
    const rows = this.db
      .prepare(`
        SELECT id, list_id, parent_id, title, notes, status, scheduled_for, due_at,
               reminder_at, priority, estimate_minutes, position, completed_at,
               deleted_at, created_at, updated_at
        FROM tasks
        ${includeDeleted ? '' : "WHERE status != 'deleted'"}
        ORDER BY position, created_at
      `)
      .all() as unknown as DbTaskRow[]

    const tagRows = this.db
      .prepare(`
        SELECT tt.task_id, t.id, t.name, t.color
        FROM task_tags tt
        JOIN tags t ON t.id = tt.tag_id
        ORDER BY t.name
      `)
      .all() as unknown as Array<{ task_id: string; id: string; name: string; color: string }>
    const tagsByTask = new Map<string, Tag[]>()
    for (const row of tagRows) {
      const tags = tagsByTask.get(row.task_id) ?? []
      tags.push({ id: row.id, name: row.name, color: row.color })
      tagsByTask.set(row.task_id, tags)
    }

    const map = new Map<string, Task>()
    for (const row of rows) {
      map.set(row.id, {
        id: row.id,
        title: row.title,
        notes: row.notes,
        listId: row.list_id,
        parentId: row.parent_id,
        status: row.status,
        scheduledFor: row.scheduled_for,
        dueAt: row.due_at,
        reminderAt: row.reminder_at,
        priority: row.priority,
        estimateMinutes: row.estimate_minutes,
        position: row.position,
        completedAt: row.completed_at,
        deletedAt: row.deleted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tags: tagsByTask.get(row.id) ?? [],
        subtasks: []
      })
    }

    const roots: Task[] = []
    for (const task of map.values()) {
      if (task.parentId && map.has(task.parentId)) {
        map.get(task.parentId)?.subtasks.push(task)
      } else {
        roots.push(task)
      }
    }
    return { roots, map }
  }

  createTask(input: CreateTaskInput): Task {
    const title = input.title.trim()
    if (!title) throw new Error('请输入任务标题')
    const id = randomUUID()
    const timestamp = nowIso()
    const listId = input.listId || 'inbox'
    this.getList(listId)
    const maxRow = this.db
      .prepare(`SELECT COALESCE(MAX(position), 0) AS position FROM tasks WHERE parent_id IS ?`)
      .get(input.parentId ?? null) as { position: number }
    this.db.prepare(`
      INSERT INTO tasks (
        id, list_id, parent_id, title, notes, status, scheduled_for, due_at,
        reminder_at, priority, estimate_minutes, position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      listId,
      input.parentId ?? null,
      title,
      input.notes?.trim() ?? '',
      input.scheduledFor ?? null,
      input.dueAt ?? null,
      input.reminderAt ?? null,
      input.priority ?? 'none',
      input.estimateMinutes ?? null,
      Number(maxRow.position) + 1000,
      timestamp,
      timestamp
    )
    if (input.tagNames) this.replaceTaskTags(id, input.tagNames)
    return this.getTask(id)
  }

  updateTask(id: string, input: UpdateTaskInput): Task {
    this.getTask(id)
    const fields: string[] = []
    const values: Array<string | number | null> = []
    const mapping: Record<string, string> = {
      title: 'title',
      notes: 'notes',
      listId: 'list_id',
      parentId: 'parent_id',
      scheduledFor: 'scheduled_for',
      dueAt: 'due_at',
      reminderAt: 'reminder_at',
      priority: 'priority',
      estimateMinutes: 'estimate_minutes',
      status: 'status'
    }
    for (const [key, column] of Object.entries(mapping)) {
      const value = input[key as keyof UpdateTaskInput]
      if (value !== undefined) {
        if (key === 'title' && !String(value).trim()) throw new Error('任务标题不能为空')
        if (key === 'listId') this.getList(String(value))
        fields.push(`${column} = ?`)
        values.push(typeof value === 'string' ? value.trim() : (value as number | null))
        if (key === 'reminderAt') fields.push('notified_at = NULL')
      }
    }
    if (fields.length) {
      fields.push('updated_at = ?')
      values.push(nowIso(), id)
      this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
    if (input.tagNames) this.replaceTaskTags(id, input.tagNames)
    return this.getTask(id)
  }

  completeTask(id: string, completed: boolean): Task {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE tasks
      SET status = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(completed ? 'completed' : 'open', completed ? timestamp : null, timestamp, id)
    return this.getTask(id)
  }

  deleteTask(id: string): void {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE tasks SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?
    `).run(timestamp, timestamp, id)
  }

  restoreTask(id: string): Task {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE tasks SET status = 'open', deleted_at = NULL, updated_at = ? WHERE id = ?
    `).run(timestamp, id)
    return this.getTask(id)
  }

  reorderTasks(ids: string[]): void {
    this.db.exec('BEGIN')
    try {
      const update = this.db.prepare(`UPDATE tasks SET position = ?, updated_at = ? WHERE id = ?`)
      const timestamp = nowIso()
      ids.forEach((id, index) => update.run((index + 1) * 1000, timestamp, id))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private replaceTaskTags(taskId: string, names: string[]): void {
    const cleanNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 8)
    const colors = ['#c96442', '#247a48', '#5d658c', '#9a681b', '#8c5d79']
    this.db.exec('BEGIN')
    try {
      this.db.prepare(`DELETE FROM task_tags WHERE task_id = ?`).run(taskId)
      const find = this.db.prepare(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE`)
      const insertTag = this.db.prepare(`INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)`)
      const link = this.db.prepare(`INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)`)
      for (const [index, name] of cleanNames.entries()) {
        const existing = find.get(name) as { id: string } | undefined
        const tagId = existing?.id ?? randomUUID()
        if (!existing) insertTag.run(tagId, name, colors[index % colors.length], nowIso())
        link.run(taskId, tagId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  addFocusSession(input: Omit<FocusSession, 'id'> & { id?: string }): FocusSession {
    const id = input.id ?? randomUUID()
    this.db.prepare(`
      INSERT OR IGNORE INTO focus_sessions (
        id, task_id, mode, started_at, ended_at, duration_seconds, note, source, source_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.taskId,
      input.mode,
      input.startedAt,
      input.endedAt,
      Math.max(0, Math.round(input.durationSeconds)),
      input.note,
      input.source,
      input.sourceKey
    )
    const row = (this.db.prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) ??
      (input.sourceKey
        ? this.db.prepare(`SELECT * FROM focus_sessions WHERE source_key = ?`).get(input.sourceKey)
        : undefined)) as DbFocusRow | undefined
    if (!row) throw new Error('专注记录没有保存成功')
    return mapFocus(row)
  }

  getFocusStats(): FocusStats {
    const rows = this.db
      .prepare(`SELECT * FROM focus_sessions ORDER BY started_at DESC`)
      .all() as unknown as DbFocusRow[]
    const sessions = rows.map(mapFocus)
    const totalsByDay = new Map<string, number>()
    let totalSeconds = 0
    for (const session of sessions) {
      const date = new Date(session.startedAt)
      const key = localDateKey(date)
      totalsByDay.set(key, (totalsByDay.get(key) ?? 0) + session.durationSeconds)
      totalSeconds += session.durationSeconds
    }
    const todaySeconds = totalsByDay.get(localDateKey()) ?? 0
    let cursor = new Date()
    if (!totalsByDay.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1)
    let streakDays = 0
    while (totalsByDay.has(localDateKey(cursor))) {
      streakDays += 1
      cursor.setDate(cursor.getDate() - 1)
    }
    const settings = this.getSettings()
    return {
      todaySeconds,
      totalSeconds,
      streakDays,
      dailyGoalMinutes: settings.dailyGoalMinutes,
      longTermGoalHours: settings.longTermGoalHours,
      longTermGoalLabel: settings.longTermGoalLabel,
      sessions: sessions.slice(0, 60)
    }
  }

  getDueReminders(): Array<{ id: string; title: string; notes: string }> {
    const now = nowIso()
    return this.db
      .prepare(`
        SELECT id, title, notes
        FROM tasks
        WHERE status = 'open'
          AND reminder_at IS NOT NULL
          AND reminder_at <= ?
          AND notified_at IS NULL
      `)
      .all(now) as unknown as Array<{ id: string; title: string; notes: string }>
  }

  markReminderNotified(id: string): void {
    this.db.prepare(`UPDATE tasks SET notified_at = ? WHERE id = ?`).run(nowIso(), id)
  }

  exportData(): Record<string, unknown> {
    const table = (name: string): unknown[] =>
      this.db.prepare(`SELECT * FROM ${name}`).all() as unknown[]
    return {
      schemaVersion: 1,
      exportedAt: nowIso(),
      data: {
        lists: table('lists'),
        tasks: table('tasks'),
        tags: table('tags'),
        taskTags: table('task_tags'),
        focusSessions: table('focus_sessions'),
        settings: table('settings')
      }
    }
  }

  importData(payload: unknown, mode: 'merge' | 'replace'): number {
    const parsed = backupSchema.safeParse(payload)
    if (!parsed.success) throw new Error('这不是有效的 Nudge 备份文件')
    const data = parsed.data.data

    const insertRow = (tableName: string, row: BackupRow, ignoreConflicts: boolean): number => {
      const columns = Object.keys(row)
      const placeholders = columns.map(() => '?').join(', ')
      const values = columns.map((column) => row[column])
      const result = this.db.prepare(`
        INSERT ${ignoreConflicts ? 'OR IGNORE ' : ''}INTO ${tableName}
        (${columns.join(', ')}) VALUES (${placeholders})
      `).run(...values)
      return Number(result.changes)
    }

    this.db.exec('BEGIN')
    try {
      this.db.exec('PRAGMA defer_foreign_keys = ON')
      if (mode === 'replace') {
        this.db.exec(`
          DELETE FROM task_tags;
          DELETE FROM focus_sessions;
          DELETE FROM tasks;
          DELETE FROM tags;
          DELETE FROM lists;
          DELETE FROM settings;
        `)
      }

      let imported = 0
      const ignoreConflicts = mode === 'merge'

      for (const row of data.lists) {
        imported += insertRow('lists', row as BackupRow, ignoreConflicts)
      }
      for (const row of data.tasks) {
        imported += insertRow('tasks', row as BackupRow, ignoreConflicts)
      }

      const tagIdMap = new Map<string, string>()
      for (const row of data.tags) {
        const byId = this.db.prepare(`SELECT id FROM tags WHERE id = ?`).get(row.id) as
          | { id: string }
          | undefined
        const byName = this.db
          .prepare(`SELECT id FROM tags WHERE name = ? COLLATE NOCASE`)
          .get(row.name) as { id: string } | undefined
        const existingId = byId?.id ?? byName?.id
        if (existingId) {
          tagIdMap.set(row.id, existingId)
          continue
        }
        imported += insertRow('tags', row as BackupRow, false)
        tagIdMap.set(row.id, row.id)
      }

      for (const row of data.taskTags) {
        imported += insertRow(
          'task_tags',
          { task_id: row.task_id, tag_id: tagIdMap.get(row.tag_id) ?? row.tag_id },
          true
        )
      }
      for (const row of data.focusSessions) {
        imported += insertRow('focus_sessions', row as BackupRow, ignoreConflicts)
      }
      for (const row of data.settings) {
        imported += insertRow('settings', row as BackupRow, ignoreConflicts)
      }

      this.db.exec('COMMIT')
      this.ensureDefaults()
      return imported
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private importLegacySessions(): void {
    for (const legacyPath of this.legacyPaths) {
      if (!existsSync(legacyPath)) continue
      try {
        const raw = JSON.parse(readFileSync(legacyPath, 'utf8')) as unknown
        const sessions = Array.isArray(raw) ? raw : [raw]
        for (const entry of sessions) {
          if (!entry || typeof entry !== 'object') continue
          const value = entry as { date?: string; time?: string; hours?: number; note?: string }
          if (!value.date || !value.hours || value.hours <= 0) continue
          const sourceKey = createHash('sha256')
            .update(`${value.date}|${value.time ?? ''}|${value.hours}|${value.note ?? ''}`)
            .digest('hex')
          const start = new Date(`${value.date}T${value.time || '12:00'}:00`)
          if (Number.isNaN(start.getTime())) continue
          const durationSeconds = Math.round(value.hours * 3600)
          const end = new Date(start.getTime() + durationSeconds * 1000)
          this.addFocusSession({
            taskId: null,
            mode: 'legacy',
            startedAt: start.toISOString(),
            endedAt: end.toISOString(),
            durationSeconds,
            note: value.note ?? '',
            source: 'study-nudge',
            sourceKey
          })
        }
      } catch {
        // A malformed legacy file should never prevent the desktop app from opening.
      }
    }
  }
}

export { DEFAULT_SETTINGS, EMPTY_FOCUS_STATE, localDateKey }
