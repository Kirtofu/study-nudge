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
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import type { Task } from '@shared/types'
import { CheckCircle2, ListChecks, Plus, Upload } from 'lucide-react'
import { useMemo } from 'react'
import { api } from '../bridge'
import { filterTasks, taskGroups } from '../features/tasks/model'
import { TaskRow } from '../features/tasks/TaskRow'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

function TaskGroup({ label, tasks }: { label: string; tasks: Task[] }): React.JSX.Element {
  const reorder = useNudgeStore((state) => state.reorderTasks)
  const showToast = useToast()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const from = tasks.findIndex((task) => task.id === active.id)
    const to = tasks.findIndex((task) => task.id === over.id)
    if (from < 0 || to < 0) return
    void reorder(arrayMove(tasks, from, to).map((task) => task.id)).catch((error) =>
      showToast({ tone: 'error', message: '顺序没有保存', detail: String(error) })
    )
  }
  return (
    <section className="task-group" aria-label={label}>
      <div className="task-group-heading">
        <h2>{label}</h2>
        <span>{tasks.length}</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          screenReaderInstructions: {
            draggable: '按空格选中任务，使用上下方向键调整本组顺序，再按空格放下。按 Escape 取消。'
          }
        }}
      >
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="task-stack">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  )
}

export function TaskList(): React.JSX.Element {
  const tasks = useNudgeStore((state) => state.tasks)
  const view = useNudgeStore((state) => state.currentView)
  const today = useNudgeStore((state) => state.today)
  const refreshData = useNudgeStore((state) => state.refreshData)
  const showToast = useToast()
  const groups = useMemo(
    () => taskGroups(filterTasks(tasks, view, '', today), view, today),
    [tasks, view, today]
  )
  if (!groups.some((group) => group.tasks.length)) {
    const firstRun = !tasks.length
    return (
      <section className="empty-state" aria-live="polite">
        <span className="empty-state-icon" aria-hidden="true">
          {view === 'completed' ? <CheckCircle2 size={28} /> : <ListChecks size={28} />}
        </span>
        <h2>
          {view === 'completed'
            ? '还没有完成记录'
            : firstRun
              ? '从一件具体的小事开始'
              : '这里暂时很清爽'}
        </h2>
        <p>
          {view === 'completed'
            ? '完成的任务会留在这里，方便回顾。'
            : '在上方写下一件要做的事，按 Enter 就能添加。'}
        </p>
        {firstRun && (
          <div className="empty-state-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => document.getElementById('quick-add-input')?.focus()}
            >
              <Plus size={15} />
              新建任务
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                void api.backup
                  .importJson('merge')
                  .then(async (result) => {
                    if (result.canceled) return
                    await refreshData()
                    showToast({
                      message: '备份已导入',
                      detail: `处理了 ${result.imported ?? 0} 条记录`
                    })
                  })
                  .catch((error) =>
                    showToast({ tone: 'error', message: '备份没有导入成功', detail: String(error) })
                  )
              }}
            >
              <Upload size={15} />
              导入备份
            </button>
          </div>
        )}
      </section>
    )
  }
  return (
    <div className="task-groups">
      {groups.map((group) => (
        <TaskGroup key={group.label} {...group} />
      ))}
    </div>
  )
}
