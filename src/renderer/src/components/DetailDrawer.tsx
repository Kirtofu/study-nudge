import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Hash,
  ListTodo,
  Play,
  Plus,
  RotateCcw,
  Save,
  Tag,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import type { Priority, Task, UpdateTaskInput } from '@shared/types'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

const PRIORITIES: Array<{ id: Priority; label: string }> = [
  { id: 'none', label: '无' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' }
]

type SaveWaiter = {
  resolve: (task: Task) => void
  reject: (error: unknown) => void
}

type TaskSaveQueue = {
  running: boolean
  pending: { input: UpdateTaskInput; waiters: SaveWaiter[] } | null
}

const taskSaveQueues = new Map<string, TaskSaveQueue>()

function enqueueTaskSave(taskId: string, input: UpdateTaskInput): Promise<Task> {
  const queue = taskSaveQueues.get(taskId) ?? { running: false, pending: null }
  taskSaveQueues.set(taskId, queue)
  const promise = new Promise<Task>((resolve, reject) => {
    if (queue.pending) {
      queue.pending.input = { ...queue.pending.input, ...input }
      queue.pending.waiters.push({ resolve, reject })
    } else {
      queue.pending = { input, waiters: [{ resolve, reject }] }
    }
  })

  const drain = async (): Promise<void> => {
    if (queue.running) return
    queue.running = true
    while (queue.pending) {
      const pending = queue.pending
      queue.pending = null
      try {
        const updated = await useNudgeStore.getState().updateTask(taskId, pending.input)
        pending.waiters.forEach((waiter) => waiter.resolve(updated))
      } catch (error) {
        pending.waiters.forEach((waiter) => waiter.reject(error))
      }
    }
    queue.running = false
    taskSaveQueues.delete(taskId)
  }
  void drain()
  return promise
}

function toLocalDateTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function fromLocalDateTime(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

export function DetailDrawer(): React.JSX.Element | null {
  const tasks = useNudgeStore((state) => state.tasks)
  const lists = useNudgeStore((state) => state.lists)
  const selectedTaskId = useNudgeStore((state) => state.selectedTaskId)
  const closeDrawer = useNudgeStore((state) => state.closeDrawer)
  const createTask = useNudgeStore((state) => state.createTask)
  const completeTask = useNudgeStore((state) => state.completeTask)
  const deleteTask = useNudgeStore((state) => state.deleteTask)
  const restoreTask = useNudgeStore((state) => state.restoreTask)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const [draft, setDraft] = useState<Task | null>(null)
  const [tagText, setTagText] = useState('')
  const [subtaskTitle, setSubtaskTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const saveVersion = useRef(0)
  const activeTaskId = useRef<string | null>(null)
  const showToast = useToast()

  const task = useMemo(
    () => tasks.find((item) => item.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks]
  )

  useEffect(() => {
    if (activeTaskId.current !== task?.id) {
      activeTaskId.current = task?.id ?? null
      setDraft(task)
      setTagText(task?.tags.map((tag) => tag.name).join(', ') ?? '')
    }
  }, [task])

  if (!task || !draft) return null

  const save = async (input: UpdateTaskInput): Promise<void> => {
    const version = ++saveVersion.current
    setSaving(true)
    setSaved(false)
    try {
      const updated = await enqueueTaskSave(task.id, input)
      if (version === saveVersion.current) {
        setDraft(updated)
        setSaved(true)
        window.setTimeout(() => setSaved(false), 1300)
      }
    } catch (error) {
      showToast({ message: '更改没有保存', detail: error instanceof Error ? error.message : '请稍后重试' })
    } finally {
      if (version === saveVersion.current) setSaving(false)
    }
  }

  const addSubtask = async (): Promise<void> => {
    const title = subtaskTitle.trim()
    if (!title) return
    await createTask({ title, listId: task.listId, parentId: task.id })
    setSubtaskTitle('')
    showToast({ message: '子任务已添加', detail: title })
  }

  const remove = async (): Promise<void> => {
    await deleteTask(task.id)
    showToast({
      message: '任务已移除',
      detail: task.title,
      actionLabel: '撤销',
      onAction: async () => {
        await restoreTask(task.id)
      }
    })
  }

  return (
    <aside className="detail-drawer" aria-label="任务详情">
      <div className="drawer-header">
        <div className="save-state" role="status">
          {saving ? (
            <>
              <Save size={13} aria-hidden="true" />正在保存
            </>
          ) : saved ? (
            <>
              <Check size={13} aria-hidden="true" />已保存
            </>
          ) : (
            <span>任务详情</span>
          )}
        </div>
        <button type="button" className="icon-button" aria-label="关闭任务详情" onClick={closeDrawer}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="drawer-scroll">
        <div className="detail-title-row">
          <button
            type="button"
            className={`detail-check ${task.status === 'completed' ? 'is-completed' : ''}`}
            aria-label={task.status === 'completed' ? '恢复任务' : '完成任务'}
            onClick={() => void completeTask(task.id, task.status !== 'completed')}
          >
            {task.status === 'completed' ? <Check size={16} /> : <Circle size={18} />}
          </button>
          <label className="sr-only" htmlFor="detail-title">
            任务标题
          </label>
          <textarea
            id="detail-title"
            className="detail-title-input"
            value={draft.title}
            rows={2}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            onBlur={() => draft.title.trim() !== task.title && void save({ title: draft.title })}
          />
        </div>

        <div className="focus-actions">
          <button type="button" className="primary-button" onClick={() => void startFocus('pomodoro', task.id)}>
            <Play size={15} fill="currentColor" aria-hidden="true" />开始 25 分钟专注
          </button>
          <button type="button" className="secondary-button" onClick={() => void startFocus('stopwatch', task.id)}>
            <Timer size={15} aria-hidden="true" />自由计时
          </button>
        </div>

        <section className="detail-section" aria-labelledby="notes-label">
          <label id="notes-label" htmlFor="detail-notes" className="field-label">
            备注
          </label>
          <textarea
            id="detail-notes"
            className="notes-input"
            value={draft.notes}
            placeholder="补充上下文、链接或下一步…"
            rows={5}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            onBlur={() => draft.notes !== task.notes && void save({ notes: draft.notes })}
          />
        </section>

        <section className="detail-section detail-fields" aria-label="任务安排">
          <label className="detail-field">
            <span>
              <ListTodo size={15} aria-hidden="true" />清单
            </span>
            <span className="select-wrap">
              <select
                value={draft.listId}
                onChange={(event) => {
                  const listId = event.target.value
                  setDraft({ ...draft, listId })
                  void save({ listId })
                }}
              >
                {lists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </label>

          <label className="detail-field">
            <span>
              <CalendarDays size={15} aria-hidden="true" />计划日期
            </span>
            <input
              type="date"
              value={draft.scheduledFor ?? ''}
              onChange={(event) => {
                const scheduledFor = event.target.value || null
                setDraft({ ...draft, scheduledFor })
                void save({ scheduledFor })
              }}
            />
          </label>

          <label className="detail-field">
            <span>
              <Clock3 size={15} aria-hidden="true" />截止时间
            </span>
            <input
              type="datetime-local"
              value={toLocalDateTime(draft.dueAt)}
              onChange={(event) => {
                const dueAt = fromLocalDateTime(event.target.value)
                setDraft({ ...draft, dueAt })
                void save({ dueAt })
              }}
            />
          </label>

          <label className="detail-field">
            <span>
              <Bell size={15} aria-hidden="true" />提醒
            </span>
            <input
              type="datetime-local"
              value={toLocalDateTime(draft.reminderAt)}
              onChange={(event) => {
                const reminderAt = fromLocalDateTime(event.target.value)
                setDraft({ ...draft, reminderAt })
                void save({ reminderAt })
              }}
            />
          </label>

          <label className="detail-field">
            <span>
              <Timer size={15} aria-hidden="true" />预计时长
            </span>
            <span className="number-field">
              <input
                type="number"
                min="1"
                max="100000"
                value={draft.estimateMinutes ?? ''}
                placeholder="—"
                onChange={(event) =>
                  setDraft({ ...draft, estimateMinutes: event.target.value ? Number(event.target.value) : null })
                }
                onBlur={() =>
                  draft.estimateMinutes !== task.estimateMinutes &&
                  void save({ estimateMinutes: draft.estimateMinutes })
                }
              />
              <small>分钟</small>
            </span>
          </label>
        </section>

        <section className="detail-section">
          <span className="field-label">
            <Hash size={14} aria-hidden="true" />优先级
          </span>
          <div className="priority-control" role="group" aria-label="优先级">
            {PRIORITIES.map((priority) => (
              <button
                type="button"
                key={priority.id}
                className={`${draft.priority === priority.id ? 'is-selected' : ''} priority-choice-${priority.id}`}
                aria-pressed={draft.priority === priority.id}
                onClick={() => {
                  setDraft({ ...draft, priority: priority.id })
                  void save({ priority: priority.id })
                }}
              >
                {priority.label}
              </button>
            ))}
          </div>
        </section>

        <section className="detail-section">
          <label className="field-label" htmlFor="detail-tags">
            <Tag size={14} aria-hidden="true" />标签
          </label>
          <input
            id="detail-tags"
            className="text-field"
            value={tagText}
            placeholder="工作, 深度学习"
            onChange={(event) => setTagText(event.target.value)}
            onBlur={() =>
              void save({ tagNames: tagText.split(/[,，]/).map((name) => name.trim()).filter(Boolean) })
            }
          />
        </section>

        <section className="detail-section subtasks-section">
          <div className="section-title-line">
            <span className="field-label">子任务</span>
            <span>{task.subtasks.filter((item) => item.status === 'completed').length}/{task.subtasks.length}</span>
          </div>
          <div className="subtask-list">
            {task.subtasks.map((subtask) => (
              <button
                type="button"
                key={subtask.id}
                className={`subtask-row ${subtask.status === 'completed' ? 'is-completed' : ''}`}
                onClick={() => void completeTask(subtask.id, subtask.status !== 'completed')}
              >
                {subtask.status === 'completed' ? <Check size={14} /> : <Circle size={15} />}
                <span>{subtask.title}</span>
              </button>
            ))}
          </div>
          <form
            className="subtask-add"
            onSubmit={(event) => {
              event.preventDefault()
              void addSubtask()
            }}
          >
            <Plus size={15} aria-hidden="true" />
            <label className="sr-only" htmlFor="subtask-title">
              新子任务
            </label>
            <input
              id="subtask-title"
              value={subtaskTitle}
              onChange={(event) => setSubtaskTitle(event.target.value)}
              placeholder="添加子任务"
            />
          </form>
        </section>
      </div>

      <div className="drawer-footer">
        <button type="button" className="danger-button" onClick={() => void remove()}>
          <Trash2 size={15} aria-hidden="true" />删除任务
        </button>
        {task.status === 'completed' ? (
          <button type="button" className="secondary-button" onClick={() => void completeTask(task.id, false)}>
            <RotateCcw size={15} aria-hidden="true" />重新打开
          </button>
        ) : null}
      </div>
    </aside>
  )
}
