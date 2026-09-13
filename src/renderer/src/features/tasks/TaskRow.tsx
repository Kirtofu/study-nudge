import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Task } from '@shared/types'
import { addDays, parseISO } from 'date-fns'
import {
  BookOpen,
  CalendarDays,
  Check,
  Circle,
  Clock3,
  GripVertical,
  ListChecks,
  MoreHorizontal,
  Play,
  Trash2
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useNudgeStore } from '../../store'
import { isCarriedTask, localDay } from './model'
import { useTaskActions } from './use-task-actions'

export function TaskRow({ task }: { task: Task }): React.JSX.Element {
  const today = useNudgeStore((state) => state.today)
  const selectTask = useNudgeStore((state) => state.selectTask)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const focusBusy = useNudgeStore((state) => state.focusBusy)
  const minutes = useNudgeStore((state) => state.settings?.pomodoroFocusMinutes ?? 25)
  const openLearning = useNudgeStore((state) => state.openLearning)
  const actions = useTaskActions()
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const menu = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: task.id })
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    menu.current?.hidePopover()
    try {
      await action()
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const learning = (): void => {
    void openLearning(task.id).catch(() => undefined)
  }
  const menuId = `task-menu-${task.id}`
  const carried = task.status === 'open' && isCarriedTask(task, today)
  return (
    <article
      ref={setNodeRef}
      data-task-id={task.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-row ${isDragging ? 'is-dragging' : ''} ${task.status === 'completed' ? 'is-completed' : ''}`}
      aria-busy={busy}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className="drag-handle"
        aria-label={`拖动“${task.title}”调整顺序`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="task-check"
        disabled={busy}
        aria-pressed={task.status === 'completed'}
        aria-label={task.status === 'completed' ? `恢复“${task.title}”` : `完成“${task.title}”`}
        onClick={() => void run(() => actions.complete(task))}
      >
        <span className="check-ring" aria-hidden="true">
          {task.status === 'completed' ? <Check size={14} /> : <Circle size={17} />}
        </span>
      </button>
      <button
        type="button"
        className="task-content task-open-button"
        onClick={() => selectTask(task.id)}
        aria-label={`打开“${task.title}”详情`}
      >
        <span className="task-title-line">
          <span className="task-title">{task.title}</span>
          {task.priority !== 'none' && (
            <span
              className={`priority-dot priority-${task.priority}`}
              aria-label={`${task.priority === 'high' ? '高' : task.priority === 'medium' ? '中' : '低'}优先级`}
            />
          )}
        </span>
        <span className="task-meta">
          {task.scheduledFor && (
            <span className={carried ? 'task-carried-date' : ''}>
              <CalendarDays size={12} aria-hidden="true" />
              {carried ? '原计划 ' : ''}
              {task.scheduledFor}
            </span>
          )}
          {task.dueAt && (
            <span>
              截止{' '}
              {new Date(task.dueAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          )}
          {task.estimateMinutes && (
            <span>
              <Clock3 size={12} aria-hidden="true" />
              {task.estimateMinutes} 分钟
            </span>
          )}
          {task.subtasks.length > 0 && (
            <span>
              <ListChecks size={12} aria-hidden="true" />
              {task.subtasks.filter((item) => item.status === 'completed').length}/
              {task.subtasks.length}
            </span>
          )}
          {task.tags.slice(0, 2).map((tag) => (
            <span key={tag.id} className="task-tag">
              #{tag.name}
            </span>
          ))}
        </span>
      </button>
      <div className="task-actions">
        <button
          type="button"
          className="icon-button learning-task-button"
          aria-label={`打开“${task.title}”学习包`}
          title="打开学习工作区"
          onClick={learning}
        >
          <BookOpen size={15} />
        </button>
        <button
          type="button"
          className="icon-button focus-task-button"
          disabled={focusBusy}
          aria-label={`专注于“${task.title}”`}
          title={`开始 ${minutes} 分钟专注`}
          onClick={() => void startFocus('pomodoro', task.id)}
        >
          <Play size={15} />
        </button>
        <button
          ref={trigger}
          type="button"
          className="icon-button task-menu-trigger"
          aria-label={`“${task.title}”更多操作`}
          aria-haspopup="dialog"
          popoverTarget={menuId}
          onClick={() => {
            const rect = trigger.current!.getBoundingClientRect()
            setPosition({
              left: Math.max(8, Math.min(window.innerWidth - 248, rect.right - 240)),
              top: Math.max(8, Math.min(window.innerHeight - 390, rect.bottom + 6))
            })
          }}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
      <div
        ref={menu}
        id={menuId}
        popover="auto"
        role="dialog"
        aria-label={`“${task.title}”任务操作`}
        className="task-menu"
        style={position}
      >
        <strong>安排日期</strong>
        <div className="task-menu-dates">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => actions.schedule(task, today))}
          >
            今天
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => actions.schedule(task, localDay(addDays(parseISO(today), 1))))
            }
          >
            明天
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => actions.schedule(task, null))}
          >
            不安排
          </button>
        </div>
        <label className="task-menu-date">
          选择日期
          <input
            type="date"
            value={task.scheduledFor ?? ''}
            disabled={busy}
            onChange={(event) => void run(() => actions.schedule(task, event.target.value || null))}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            menu.current?.hidePopover()
            selectTask(task.id)
          }}
        >
          打开详情
        </button>
        <button
          type="button"
          onClick={() => {
            menu.current?.hidePopover()
            learning()
          }}
        >
          <BookOpen size={14} />
          学习工作区
        </button>
        <button
          type="button"
          disabled={focusBusy}
          onClick={() => {
            menu.current?.hidePopover()
            void startFocus('pomodoro', task.id)
          }}
        >
          <Play size={14} />
          专注 {minutes} 分钟
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => actions.complete(task))}
        >
          <Check size={14} />
          {task.status === 'completed' ? '重新打开' : '完成任务'}
        </button>
        <button
          type="button"
          className="danger-button"
          disabled={busy}
          onClick={() => void run(() => actions.remove(task))}
        >
          <Trash2 size={14} />
          删除任务
        </button>
      </div>
    </article>
  )
}
