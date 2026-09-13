import type { Priority, Task } from '@shared/types'
import {
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  Circle,
  Clock3,
  Hash,
  ListTodo,
  Play,
  Plus,
  RotateCcw,
  Tag,
  Timer,
  Trash2,
  X
} from 'lucide-react'
import { useRef, useState } from 'react'
import { findTask } from '../features/tasks/model'
import { useTaskActions } from '../features/tasks/use-task-actions'
import { useTaskDraft } from '../features/tasks/use-task-draft'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

const PRIORITIES: Array<{ id: Priority; label: string }> = [
  { id: 'none', label: '无' },
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' }
]

function localDateTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
const toISO = (value: string): string | null => (value ? new Date(value).toISOString() : null)

export function DetailDrawer(): React.JSX.Element | null {
  const task = useNudgeStore((state) => findTask(state.tasks, state.selectedTaskId))
  return task ? <TaskDetails key={task.id} task={task} /> : null
}

function TaskDetails({ task }: { task: Task }): React.JSX.Element {
  const lists = useNudgeStore((state) => state.lists)
  const closeDrawer = useNudgeStore((state) => state.closeDrawer)
  const selectTask = useNudgeStore((state) => state.selectTask)
  const createTask = useNudgeStore((state) => state.createTask)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const openLearning = useNudgeStore((state) => state.openLearning)
  const minutes = useNudgeStore((state) => state.settings?.pomodoroFocusMinutes ?? 25)
  const focusBusy = useNudgeStore((state) => state.focusBusy)
  const { value: draft, edit, flush, status, error } = useTaskDraft(task)
  const actions = useTaskActions()
  const showToast = useToast()
  const [subtaskTitle, setSubtaskTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const composing = useRef(false)
  const addSubtask = async (): Promise<void> => {
    if (lock.current || composing.current || !subtaskTitle.trim()) return
    const title = subtaskTitle.trim()
    lock.current = true
    setBusy(true)
    try {
      await createTask({ title, listId: task.listId, parentId: task.id })
      setSubtaskTitle((current) => (current.trim() === title ? '' : current))
    } catch (cause) {
      showToast({ tone: 'error', message: '子任务没有保存', detail: String(cause) })
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const afterSave = async (action: () => Promise<unknown> | void): Promise<void> => {
    if (await flush()) await action()
  }
  return (
    <aside className={`detail-drawer${error ? ' has-save-error' : ''}`} aria-label="任务详情">
      <div className="drawer-header">
        <div className={`save-state save-${status}`} role="status">
          {status === 'saved' ? (
            <>
              <Check size={13} />
              已保存
            </>
          ) : status === 'error' ? (
            '保存失败'
          ) : status === 'saving' ? (
            '保存中…'
          ) : (
            '等待保存…'
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭任务详情"
          onClick={() => void afterSave(closeDrawer)}
        >
          <X size={17} />
        </button>
      </div>
      {error && (
        <div className="save-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void flush()}>
            重试保存
          </button>
        </div>
      )}
      <div className="drawer-scroll">
        <div className="detail-title-row">
          <button
            type="button"
            className={`detail-check ${task.status === 'completed' ? 'is-completed' : ''}`}
            aria-label={task.status === 'completed' ? '恢复任务' : '完成任务'}
            onClick={() => void afterSave(() => actions.complete(task))}
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
            onChange={(event) => edit('title', event.target.value)}
            onBlur={() => void flush()}
          />
        </div>
        <div className="focus-actions">
          <button
            type="button"
            className="primary-button"
            disabled={focusBusy}
            onClick={() => void afterSave(() => startFocus('pomodoro', task.id))}
          >
            <Play size={15} />
            专注 {minutes} 分钟
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={focusBusy}
            onClick={() => void afterSave(() => startFocus('stopwatch', task.id))}
          >
            <Timer size={15} />
            自由计时
          </button>
        </div>
        <button
          type="button"
          className="detail-learning-entry"
          onClick={() => void afterSave(() => openLearning(task.id).catch(() => undefined))}
        >
          <BookOpen size={16} />
          <span>
            打开学习工作区<small>资料、视频与学习路线</small>
          </span>
        </button>
        <section className="detail-section">
          <label htmlFor="detail-notes" className="field-label">
            备注
          </label>
          <textarea
            id="detail-notes"
            className="notes-input"
            value={draft.notes}
            rows={4}
            placeholder="补充上下文、链接或下一步…"
            onChange={(event) => edit('notes', event.target.value)}
            onBlur={() => void flush()}
          />
        </section>
        <section className="detail-section detail-fields" aria-label="任务安排">
          <label className="detail-field">
            <span>
              <ListTodo size={15} />
              清单
            </span>
            <select value={draft.listId} onChange={(event) => edit('listId', event.target.value)}>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
          <label className="detail-field">
            <span>
              <CalendarDays size={15} />
              计划日期
            </span>
            <input
              type="date"
              value={draft.scheduledFor ?? ''}
              onChange={(event) => edit('scheduledFor', event.target.value || null)}
              onBlur={() => void flush()}
            />
          </label>
          <label className="detail-field">
            <span>
              <Clock3 size={15} />
              截止时间
            </span>
            <input
              type="datetime-local"
              value={localDateTime(draft.dueAt)}
              onChange={(event) => edit('dueAt', toISO(event.target.value))}
              onBlur={() => void flush()}
            />
          </label>
          <label className="detail-field">
            <span>
              <Bell size={15} />
              提醒
            </span>
            <input
              type="datetime-local"
              value={localDateTime(draft.reminderAt)}
              onChange={(event) => edit('reminderAt', toISO(event.target.value))}
              onBlur={() => void flush()}
            />
          </label>
          <label className="detail-field">
            <span>
              <Timer size={15} />
              预计时长
            </span>
            <span className="number-field">
              <input
                type="number"
                min="1"
                max="100000"
                value={draft.estimateMinutes ?? ''}
                placeholder="—"
                onChange={(event) =>
                  edit('estimateMinutes', event.target.value ? Number(event.target.value) : null)
                }
                onBlur={() => void flush()}
              />
              <small>分钟</small>
            </span>
          </label>
        </section>
        <section className="detail-section">
          <span className="field-label">
            <Hash size={14} />
            优先级
          </span>
          <div className="priority-control" role="group" aria-label="优先级">
            {PRIORITIES.map((priority) => (
              <button
                type="button"
                key={priority.id}
                className={`${draft.priority === priority.id ? 'is-selected' : ''} priority-choice-${priority.id}`}
                aria-pressed={draft.priority === priority.id}
                onClick={() => edit('priority', priority.id)}
              >
                {priority.label}
              </button>
            ))}
          </div>
        </section>
        <section className="detail-section">
          <label className="field-label" htmlFor="detail-tags">
            <Tag size={14} />
            标签
          </label>
          <input
            id="detail-tags"
            className="text-field"
            value={draft.tagText}
            placeholder="工作, 深度学习"
            onChange={(event) => edit('tagText', event.target.value)}
            onBlur={() => void flush()}
          />
        </section>
        <section className="detail-section subtasks-section">
          <div className="section-title-line">
            <span className="field-label">子任务</span>
            <span>
              {task.subtasks.filter((item) => item.status === 'completed').length}/
              {task.subtasks.length}
            </span>
          </div>
          <div className="subtask-list">
            {task.subtasks.map((subtask) => (
              <div
                key={subtask.id}
                className={`subtask-row ${subtask.status === 'completed' ? 'is-completed' : ''}`}
              >
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`${subtask.status === 'completed' ? '恢复' : '完成'}“${subtask.title}”`}
                  onClick={() => void actions.complete(subtask)}
                >
                  {subtask.status === 'completed' ? <Check size={14} /> : <Circle size={15} />}
                </button>
                <button
                  type="button"
                  className="subtask-title"
                  onClick={() => void afterSave(() => selectTask(subtask.id))}
                >
                  {subtask.title}
                </button>
              </div>
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
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
                )
                  event.preventDefault()
              }}
            />
            <button
              type="submit"
              className="icon-button"
              aria-label="添加子任务"
              disabled={busy || !subtaskTitle.trim()}
            >
              <Plus size={15} />
            </button>
          </form>
        </section>
      </div>
      <div className="drawer-footer">
        <button
          type="button"
          className="danger-button"
          onClick={() => void afterSave(() => actions.remove(task))}
        >
          <Trash2 size={15} />
          删除任务
        </button>
        {task.status === 'completed' && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void actions.complete(task)}
          >
            <RotateCcw size={15} />
            重新打开
          </button>
        )}
      </div>
    </aside>
  )
}
