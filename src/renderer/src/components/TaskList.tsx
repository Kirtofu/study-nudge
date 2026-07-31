import { useMemo, useState } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { AnimatePresence, motion } from 'motion/react'
import {
  CalendarClock,
  Check,
  CheckCircle2,
  Circle,
  Clock3,
  GripVertical,
  ListChecks,
  Play,
  Tag as TagIcon
} from 'lucide-react'
import type { Priority, Task } from '@shared/types'
import { useNudgeStore } from '../store'
import { filterTasks, formatClock, groupLabel } from '../utils'
import { useToast } from './Toast'

const GROUPS = ['上午', '下午', '晚间', '随时'] as const

const PRIORITY_LABEL: Record<Priority, string> = {
  none: '无优先级',
  low: '低优先级',
  medium: '中优先级',
  high: '高优先级'
}

function SortableTaskRow({ task }: { task: Task }): React.JSX.Element {
  const currentView = useNudgeStore((state) => state.currentView)
  const selectTask = useNudgeStore((state) => state.selectTask)
  const completeTask = useNudgeStore((state) => state.completeTask)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const [completing, setCompleting] = useState(false)
  const showToast = useToast()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })

  const complete = (): void => {
    if (task.status === 'completed') {
      void completeTask(task.id, false)
      showToast({ message: '任务已重新放回清单' })
      return
    }
    if (completing) return
    setCompleting(true)
    window.setTimeout(() => {
      void completeTask(task.id, true).then(() => {
        showToast({
          message: '完成得漂亮',
          detail: task.title,
          actionLabel: '撤销',
          onAction: async () => {
            await completeTask(task.id, false)
          }
        })
      })
    }, 360)
  }

  return (
    <motion.article
      ref={setNodeRef}
      layout
      initial={{ opacity: 0, y: 7 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 18, filter: 'blur(2px)' }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-row ${isDragging ? 'is-dragging' : ''} ${completing ? 'is-completing' : ''} ${task.status === 'completed' ? 'is-completed' : ''}`}
      onClick={() => selectTask(task.id)}
    >
      <button
        type="button"
        className="drag-handle"
        aria-label={`拖动“${task.title}”调整顺序`}
        {...attributes}
        {...listeners}
        onClick={(event) => event.stopPropagation()}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="task-check"
        aria-label={task.status === 'completed' ? `恢复“${task.title}”` : `完成“${task.title}”`}
        aria-pressed={task.status === 'completed'}
        onClick={(event) => {
          event.stopPropagation()
          complete()
        }}
      >
        <span className="check-ring" aria-hidden="true">
          {task.status === 'completed' || completing ? <Check size={14} strokeWidth={2.6} /> : <Circle size={17} />}
        </span>
        <span className="ink-dot ink-dot-one" />
        <span className="ink-dot ink-dot-two" />
        <span className="ink-dot ink-dot-three" />
      </button>

      <div className="task-content">
        <div className="task-title-line">
          <h3>{task.title}</h3>
          {task.priority !== 'none' ? (
            <span className={`priority-dot priority-${task.priority}`} title={PRIORITY_LABEL[task.priority]} />
          ) : null}
        </div>
        <div className="task-meta">
          {task.dueAt ? (
            <span>
              <CalendarClock size={12} aria-hidden="true" />
              {formatClock(task.dueAt)}
            </span>
          ) : null}
          {task.estimateMinutes ? (
            <span>
              <Clock3 size={12} aria-hidden="true" />
              {task.estimateMinutes} 分钟
            </span>
          ) : null}
          {task.subtasks.length ? (
            <span>
              <ListChecks size={12} aria-hidden="true" />
              {task.subtasks.filter((item) => item.status === 'completed').length}/{task.subtasks.length}
            </span>
          ) : null}
          {task.tags.slice(0, 2).map((tag) => (
            <span key={tag.id} className="task-tag">
              <TagIcon size={11} aria-hidden="true" />{tag.name}
            </span>
          ))}
        </div>
      </div>

      <div className="task-actions">
        <button
          type="button"
          className="icon-button focus-task-button"
          aria-label={`专注于“${task.title}”`}
          title="开始专注"
          onClick={(event) => {
            event.stopPropagation()
            void startFocus('pomodoro', task.id)
            showToast({ message: '专注计时已经开始', detail: task.title })
          }}
        >
          <Play size={15} fill="currentColor" aria-hidden="true" />
        </button>
      </div>
      {currentView === 'completed' ? <CheckCircle2 className="completed-stamp" size={17} aria-hidden="true" /> : null}
    </motion.article>
  )
}

export function TaskList(): React.JSX.Element {
  const tasks = useNudgeStore((state) => state.tasks)
  const currentView = useNudgeStore((state) => state.currentView)
  const search = useNudgeStore((state) => state.search)
  const reorderTasks = useNudgeStore((state) => state.reorderTasks)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const visibleTasks = useMemo(
    () => filterTasks(tasks, currentView, search),
    [currentView, search, tasks]
  )

  const grouped = useMemo(() => {
    if (currentView !== 'today') return [{ label: '任务', tasks: visibleTasks }]
    return GROUPS.map((label) => ({
      label,
      tasks: visibleTasks.filter((task) => groupLabel(task) === label)
    })).filter((group) => group.tasks.length)
  }, [currentView, visibleTasks])

  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = visibleTasks.findIndex((task) => task.id === active.id)
    const newIndex = visibleTasks.findIndex((task) => task.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const next = arrayMove(visibleTasks, oldIndex, newIndex)
    void reorderTasks(next.map((task) => task.id))
  }

  if (!visibleTasks.length) {
    return (
      <section className="empty-state" aria-live="polite">
        <span className="empty-state-icon" aria-hidden="true">
          {currentView === 'completed' ? <CheckCircle2 size={28} /> : <ListChecks size={28} />}
        </span>
        <h2>{search ? '没有找到匹配的任务' : currentView === 'completed' ? '还没有完成记录' : '这里暂时很清爽'}</h2>
        <p>{search ? '换一个关键词试试。' : '在上方写下一件要做的事，按 Enter 就能添加。'}</p>
      </section>
    )
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={visibleTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
        <div className="task-groups">
          {grouped.map((group) => (
            <section className="task-group" key={group.label} aria-labelledby={`group-${group.label}`}>
              <div className="task-group-heading">
                <h2 id={`group-${group.label}`}>{group.label}</h2>
                <span>{group.tasks.length}</span>
              </div>
              <div className="task-stack">
                <AnimatePresence initial={false} mode="popLayout">
                  {group.tasks.map((task) => (
                    <SortableTaskRow key={task.id} task={task} />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
