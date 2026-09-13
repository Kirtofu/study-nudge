import type { FocusHistoryPage, FocusSession } from '@shared/types'
import { CalendarDays, Clock3, History, LoaderCircle, Maximize2, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../bridge'
import { useNudgeStore } from '../store'
import { formatDuration } from '../utils'

type HistoryRange = '7d' | '30d' | 'all'

const RANGE_OPTIONS: Array<{ value: HistoryRange; label: string }> = [
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' }
]

function dayKey(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toLocaleDateString('zh-CN')
}

function findTaskTitle(
  tasks: ReturnType<typeof useNudgeStore.getState>['tasks'],
  id: string | null
): string {
  if (!id) return '未关联任务'
  const queue = [...tasks]
  while (queue.length) {
    const task = queue.shift()!
    if (task.id === id) return task.title
    queue.push(...task.subtasks)
  }
  return '已移除的任务'
}

export function FocusHistoryDrawer(): React.JSX.Element {
  const tasks = useNudgeStore((state) => state.tasks)
  const closeDrawer = useNudgeStore((state) => state.closeDrawer)
  const [range, setRange] = useState<HistoryRange>('7d')
  const [page, setPage] = useState<FocusHistoryPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async (nextRange = range): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setPage(await api.focus.history({ range: nextRange, limit: 300 }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '专注记录暂时没有打开')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(range)
  }, [range])

  const groups = useMemo(() => {
    const grouped = new Map<string, FocusSession[]>()
    for (const session of page?.items ?? []) {
      const key = dayKey(session.endedAt)
      grouped.set(key, [...(grouped.get(key) ?? []), session])
    }
    return [...grouped.entries()]
  }, [page])

  const totalSeconds = page?.items.reduce((sum, session) => sum + session.durationSeconds, 0) ?? 0

  return (
    <aside className="detail-drawer focus-history-drawer" aria-label="专注历史">
      <div className="drawer-header">
        <div className="save-state">
          <History size={14} aria-hidden="true" />
          <span>专注历史</span>
        </div>
        <div className="drawer-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="打开专注迷你窗"
            onClick={() => void api.desktop.toggleMiniWindow()}
          >
            <Maximize2 size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭专注历史"
            onClick={closeDrawer}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="history-toolbar">
        <div className="settings-tabs history-range-tabs" role="tablist" aria-label="专注历史范围">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={range === option.value}
              className={range === option.value ? 'is-active' : ''}
              onClick={() => setRange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="history-summary" aria-live="polite">
          <Clock3 size={14} aria-hidden="true" />
          <strong>{formatDuration(totalSeconds)}</strong>
          <span>{page?.total ?? 0} 次</span>
        </div>
      </div>

      <div className="drawer-scroll history-scroll">
        {loading ? (
          <div className="drawer-loading" role="status">
            <LoaderCircle className="spin" size={18} />
            正在整理专注记录
          </div>
        ) : error ? (
          <div className="drawer-error" role="alert">
            <p>{error}</p>
            <button type="button" className="secondary-button" onClick={() => void load()}>
              <RotateCcw size={14} />
              重新加载
            </button>
          </div>
        ) : groups.length ? (
          groups.map(([date, sessions]) => (
            <section className="history-day" key={date} aria-labelledby={`history-${date}`}>
              <div className="history-day-heading">
                <h2 id={`history-${date}`}>
                  <CalendarDays size={14} aria-hidden="true" />
                  {date}
                </h2>
                <span>
                  {formatDuration(sessions.reduce((sum, item) => sum + item.durationSeconds, 0))}
                </span>
              </div>
              <div className="history-session-list">
                {sessions.map((session) => (
                  <article className="history-session" key={session.id}>
                    <div>
                      <strong>{findTaskTitle(tasks, session.taskId)}</strong>
                      <span>
                        {session.mode === 'pomodoro'
                          ? '番茄专注'
                          : session.mode === 'stopwatch'
                            ? '自由计时'
                            : '旧版记录'}
                      </span>
                    </div>
                    <div className="history-session-time">
                      <strong>{formatDuration(session.durationSeconds)}</strong>
                      <time dateTime={session.endedAt}>
                        {new Date(session.endedAt).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </time>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="history-empty">
            <History size={24} aria-hidden="true" />
            <h2>这个范围还没有专注记录</h2>
            <p>开始一次计时，完成后会自动出现在这里。</p>
          </div>
        )}
      </div>
    </aside>
  )
}
