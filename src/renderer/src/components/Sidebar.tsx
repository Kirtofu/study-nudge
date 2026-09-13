import type { ViewId } from '@shared/types'
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Inbox,
  ListTodo,
  Plus,
  Settings,
  SunMedium,
  TimerReset,
  X
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNudgeStore } from '../store'
import { filterTasks, formatDuration } from '../utils'
import { useToast } from './Toast'

type NavItem = {
  id: ViewId
  label: string
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; 'aria-hidden'?: boolean }>
}

const NAV_ITEMS: NavItem[] = [
  { id: 'inbox', label: '收集箱', icon: Inbox },
  { id: 'today', label: '今天', icon: SunMedium },
  { id: 'upcoming', label: '计划', icon: CalendarDays },
  { id: 'completed', label: '已完成', icon: CheckCircle2 }
]

export function Sidebar(): React.JSX.Element {
  const currentView = useNudgeStore((state) => state.currentView)
  const tasks = useNudgeStore((state) => state.tasks)
  const today = useNudgeStore((state) => state.today)
  const lists = useNudgeStore((state) => state.lists)
  const focusStats = useNudgeStore((state) => state.focusStats)
  const setView = useNudgeStore((state) => state.setView)
  const createList = useNudgeStore((state) => state.createList)
  const openSettings = useNudgeStore((state) => state.openSettings)
  const openFocusHistory = useNudgeStore((state) => state.openFocusHistory)
  const [addingList, setAddingList] = useState(false)
  const [newListName, setNewListName] = useState('')
  const showToast = useToast()

  const counts = useMemo(
    () =>
      Object.fromEntries(
        NAV_ITEMS.map((item) => [item.id, filterTasks(tasks, item.id, '', today).length])
      ) as Record<ViewId, number>,
    [tasks, today]
  )

  const submitList = async (): Promise<void> => {
    const name = newListName.trim()
    if (!name) return
    try {
      await createList(name)
      setNewListName('')
      setAddingList(false)
      showToast({ message: `已创建“${name}”清单` })
    } catch (error) {
      showToast({
        message: '清单没有创建成功',
        detail: error instanceof Error ? error.message : '请稍后重试'
      })
    }
  }

  const dailyProgress = focusStats
    ? Math.min(1, focusStats.todaySeconds / Math.max(60, focusStats.dailyGoalMinutes * 60))
    : 0

  return (
    <aside className="sidebar" aria-label="任务导航">
      <nav className="sidebar-nav">
        <p className="sidebar-label">我的一天</p>
        <div className="nav-stack">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = currentView === item.id
            return (
              <button
                type="button"
                key={item.id}
                className={`nav-item ${active ? 'is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => setView(item.id)}
              >
                <Icon size={17} strokeWidth={1.9} aria-hidden={true} />
                <span>{item.label}</span>
                <span className="nav-count">{counts[item.id] ?? 0}</span>
              </button>
            )
          })}
        </div>

        <div className="sidebar-section-heading">
          <p className="sidebar-label">清单</p>
          <button
            type="button"
            className="icon-button sidebar-add"
            aria-label="新建清单"
            onClick={() => setAddingList(true)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="nav-stack list-navigation">
          {lists
            .filter((list) => list.id !== 'inbox')
            .map((list) => {
              const view = `list:${list.id}` as ViewId
              const active = currentView === view
              const count = tasks.filter(
                (task) => task.status === 'open' && task.listId === list.id
              ).length
              return (
                <button
                  type="button"
                  key={list.id}
                  className={`nav-item ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setView(view)}
                >
                  <span
                    className="list-color"
                    style={{ backgroundColor: list.color }}
                    aria-hidden="true"
                  />
                  <span>{list.name}</span>
                  <span className="nav-count">{count}</span>
                </button>
              )
            })}
          {addingList ? (
            <form
              className="new-list-form"
              onSubmit={(event) => {
                event.preventDefault()
                void submitList()
              }}
            >
              <ListTodo size={15} aria-hidden="true" />
              <label className="sr-only" htmlFor="new-list-name">
                清单名称
              </label>
              <input
                id="new-list-name"
                value={newListName}
                onChange={(event) => setNewListName(event.target.value)}
                onBlur={() => !newListName.trim() && setAddingList(false)}
                placeholder="清单名称"
                autoFocus
              />
              <button
                type="button"
                className="icon-button"
                aria-label="取消新建清单"
                onClick={() => setAddingList(false)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </form>
          ) : null}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button type="button" className="focus-summary" onClick={openFocusHistory}>
          <span
            className="focus-summary-ring"
            style={{ '--progress': dailyProgress } as React.CSSProperties}
          >
            <TimerReset size={16} aria-hidden="true" />
          </span>
          <span className="focus-summary-copy">
            <strong>今日专注</strong>
            <small>
              {focusStats ? formatDuration(focusStats.todaySeconds) : '0分钟'} · 连续{' '}
              {focusStats?.streakDays ?? 0} 天
            </small>
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
        <button type="button" className="settings-button" onClick={openSettings}>
          <Settings size={16} aria-hidden="true" />
          <span>设置与备份</span>
        </button>
      </div>
    </aside>
  )
}
