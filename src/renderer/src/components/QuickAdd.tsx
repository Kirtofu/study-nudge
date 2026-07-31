import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, format } from 'date-fns'
import { ArrowUp, CalendarPlus, Inbox, Plus, Sparkles } from 'lucide-react'
import type { Priority } from '@shared/types'
import { api } from '../bridge'
import { useNudgeStore } from '../store'
import { dateKey } from '../utils'
import { useToast } from './Toast'

export function parseQuickTask(raw: string): { title: string; priority: Priority; tagNames: string[] } {
  const tagNames = Array.from(raw.matchAll(/#([^\s#]+)/g)).map((match) => match[1])
  let priority: Priority = 'none'
  if (/!高(?=\s|$)|!high\b/i.test(raw)) priority = 'high'
  else if (/!中(?=\s|$)|!medium\b/i.test(raw)) priority = 'medium'
  else if (/!低(?=\s|$)|!low\b/i.test(raw)) priority = 'low'
  const title = raw
    .replace(/#([^\s#]+)/g, '')
    .replace(/!(?:高|中|低)(?=\s|$)|!(?:high|medium|low)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { title, priority, tagNames }
}

export function QuickAdd(): React.JSX.Element {
  const currentView = useNudgeStore((state) => state.currentView)
  const createTask = useNudgeStore((state) => state.createTask)
  const closeDrawer = useNudgeStore((state) => state.closeDrawer)
  const [value, setValue] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [schedule, setSchedule] = useState<'view' | 'today' | 'tomorrow' | 'inbox'>('view')
  const inputRef = useRef<HTMLInputElement>(null)
  const showToast = useToast()

  useEffect(() => {
    const focusInput = (): void => {
      setExpanded(true)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
    const offQuickAdd = api.desktop.onQuickAdd(focusInput)
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        focusInput()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      offQuickAdd()
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const viewDefaults = useMemo(() => {
    if (currentView.startsWith('list:')) return { listId: currentView.slice(5), scheduledFor: null }
    if (currentView === 'today') return { listId: 'inbox', scheduledFor: dateKey() }
    if (currentView === 'upcoming') {
      return { listId: 'inbox', scheduledFor: format(addDays(new Date(), 1), 'yyyy-MM-dd') }
    }
    return { listId: 'inbox', scheduledFor: null }
  }, [currentView])

  const submit = async (): Promise<void> => {
    const parsed = parseQuickTask(value)
    if (!parsed.title) return
    let scheduledFor = viewDefaults.scheduledFor
    if (schedule === 'today') scheduledFor = dateKey()
    if (schedule === 'tomorrow') scheduledFor = format(addDays(new Date(), 1), 'yyyy-MM-dd')
    if (schedule === 'inbox') scheduledFor = null
    try {
      await createTask({
        title: parsed.title,
        listId: viewDefaults.listId,
        scheduledFor,
        priority: parsed.priority,
        tagNames: parsed.tagNames
      })
      closeDrawer()
      setValue('')
      setExpanded(false)
      setSchedule('view')
      showToast({ message: '任务已经记下来了', detail: parsed.title })
    } catch (error) {
      showToast({ message: '任务没有添加成功', detail: error instanceof Error ? error.message : '请稍后重试' })
    }
  }

  return (
    <form
      className={`quick-add ${expanded ? 'is-expanded' : ''}`}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <span className="quick-add-leading" aria-hidden="true">
        {expanded ? <Sparkles size={18} /> : <Plus size={18} />}
      </span>
      <label className="sr-only" htmlFor="quick-add-input">
        快速添加任务
      </label>
      <input
        ref={inputRef}
        id="quick-add-input"
        value={value}
        onFocus={() => setExpanded(true)}
        onChange={(event) => setValue(event.target.value)}
        placeholder="添加一件要做的事…"
        autoComplete="off"
      />
      {expanded ? (
        <div className="quick-add-options" aria-label="安排任务">
          <button
            type="button"
            className={schedule === 'today' ? 'is-selected' : ''}
            onClick={() => setSchedule('today')}
          >
            <CalendarPlus size={13} aria-hidden="true" />今天
          </button>
          <button
            type="button"
            className={schedule === 'tomorrow' ? 'is-selected' : ''}
            onClick={() => setSchedule('tomorrow')}
          >
            明天
          </button>
          <button
            type="button"
            className={schedule === 'inbox' ? 'is-selected' : ''}
            onClick={() => setSchedule('inbox')}
          >
            <Inbox size={13} aria-hidden="true" />收集箱
          </button>
          <span className="quick-add-hint">支持 #标签 与 !高 / !中 / !低</span>
        </div>
      ) : null}
      <button type="submit" className="quick-add-submit" disabled={!parseQuickTask(value).title} aria-label="添加任务">
        <ArrowUp size={16} aria-hidden="true" />
      </button>
    </form>
  )
}
