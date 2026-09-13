import { addDays, parseISO } from 'date-fns'
import { ArrowUp, CalendarDays, ListTodo, Plus, Route } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { localDay } from '../features/tasks/model'
import { parseQuickTask } from '../features/tasks/quick-task'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

export { parseQuickTask } from '../features/tasks/quick-task'

export function QuickAdd(): React.JSX.Element {
  const currentView = useNudgeStore((state) => state.currentView)
  const today = useNudgeStore((state) => state.today)
  const lists = useNudgeStore((state) => state.lists)
  const createTask = useNudgeStore((state) => state.createTask)
  const openLearning = useNudgeStore((state) => state.openLearning)
  const [value, setValue] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [date, setDate] = useState<string | null>(null)
  const [list, setList] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const composing = useRef(false)
  const generation = useRef(0)
  const showToast = useToast()
  const tomorrow = localDay(addDays(parseISO(today), 1))
  const defaultDate = currentView === 'today' ? today : currentView === 'upcoming' ? tomorrow : ''
  const scheduledFor = date ?? defaultDate
  const listId = list ?? (currentView.startsWith('list:') ? currentView.slice(5) : 'inbox')

  useEffect(() => {
    setDate(null)
    setList(null)
  }, [currentView])

  const submit = async (withPlanning = false): Promise<void> => {
    if (busy.current || composing.current) return
    const parsed = parseQuickTask(value)
    if (!parsed.title) return
    busy.current = true
    setSubmitting(true)
    const revision = generation.current
    let savedId: string | null = null
    try {
      const task = await createTask({ ...parsed, listId, scheduledFor: scheduledFor || null })
      savedId = task.id
      if (generation.current === revision) setValue('')
      if (withPlanning) {
        await openLearning(task.id)
      } else {
        showToast({ message: '任务已记下', detail: task.title, duration: 2200 })
        inputRef.current?.focus()
      }
    } catch (error) {
      showToast({
        tone: 'error',
        message: savedId ? '任务已保存，学习包暂时没有打开' : '任务没有添加成功',
        detail: error instanceof Error ? error.message : '请重试',
        ...(savedId
          ? {
              actionLabel: '打开学习包',
              onAction: async () => {
                await openLearning(savedId!)
              }
            }
          : {})
      })
    } finally {
      busy.current = false
      setSubmitting(false)
    }
  }

  return (
    <form
      className={`quick-add ${expanded ? 'is-expanded' : ''}`}
      aria-label="快速记录"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <span className="quick-add-leading" aria-hidden="true">
        <Plus size={19} />
      </span>
      <label className="sr-only" htmlFor="quick-add-input">
        快速添加任务
      </label>
      <input
        ref={inputRef}
        id="quick-add-input"
        value={value}
        autoComplete="off"
        placeholder="添加一件要做的事…"
        onFocus={() => setExpanded(true)}
        onChange={(event) => {
          generation.current++
          setValue(event.target.value)
        }}
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
        className="quick-add-action quick-add-action-primary"
        disabled={!parseQuickTask(value).title || submitting}
        aria-label="添加任务"
      >
        <ArrowUp size={16} aria-hidden="true" />
        <span>{submitting ? '保存中…' : '添加'}</span>
      </button>
      {expanded && (
        <div className="quick-add-options" aria-label="安排任务">
          <label className="quick-add-date">
            <CalendarDays size={14} aria-hidden="true" />
            <span className="sr-only">新任务日期</span>
            <input
              type="date"
              aria-label="新任务日期"
              value={scheduledFor}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <button type="button" onClick={() => setDate('')} aria-pressed={!scheduledFor}>
            不安排
          </button>
          <label className="quick-add-list">
            <ListTodo size={14} aria-hidden="true" />
            <span className="sr-only">新任务清单</span>
            <select
              aria-label="新任务清单"
              value={listId}
              onChange={(event) => setList(event.target.value)}
            >
              {lists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <span className="quick-add-hint">Enter 连续记录 · #标签 · !高</span>
          <button
            type="button"
            className="quick-plan-link"
            disabled={!parseQuickTask(value).title || submitting}
            onClick={() => void submit(true)}
          >
            <Route size={14} aria-hidden="true" />
            添加并规划学习
          </button>
        </div>
      )}
    </form>
  )
}
