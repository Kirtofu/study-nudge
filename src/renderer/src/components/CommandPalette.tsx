import {
  CalendarDays,
  CheckCircle2,
  Circle,
  Download,
  Inbox,
  ListPlus,
  Play,
  Search,
  Settings,
  SunMedium,
  TimerReset,
  X,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../bridge'
import { flattenTasks, matchesTask } from '../features/tasks/model'
import { beginAdd } from '../features/tasks/navigation'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

type Result = {
  id: string
  label: string
  detail: string
  icon: LucideIcon
  completed?: boolean
  action: () => void | Promise<unknown>
}

export function CommandPalette(): React.JSX.Element {
  const open = useNudgeStore((state) => state.commandOpen)
  const setOpen = useNudgeStore((state) => state.setCommandOpen)
  const setView = useNudgeStore((state) => state.setView)
  const selectTask = useNudgeStore((state) => state.selectTask)
  const openSettings = useNudgeStore((state) => state.openSettings)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const tasks = useNudgeStore((state) => state.tasks)
  const minutes = useNudgeStore((state) => state.settings?.pomodoroFocusMinutes ?? 25)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const showToast = useToast()
  const commands = useMemo<Result[]>(
    () => [
      { id: 'new', label: '添加新任务', detail: 'Ctrl N', icon: ListPlus, action: beginAdd },
      {
        id: 'today',
        label: '打开今天',
        detail: '今天与此前未完成',
        icon: SunMedium,
        action: () => setView('today')
      },
      {
        id: 'inbox',
        label: '打开收集箱',
        detail: '尚未安排日期',
        icon: Inbox,
        action: () => setView('inbox')
      },
      {
        id: 'upcoming',
        label: '打开计划',
        detail: '未来安排',
        icon: CalendarDays,
        action: () => setView('upcoming')
      },
      {
        id: 'completed',
        label: '查看已完成',
        detail: '回顾完成记录',
        icon: CheckCircle2,
        action: () => setView('completed')
      },
      {
        id: 'pomodoro',
        label: `开始 ${minutes} 分钟专注`,
        detail: '番茄钟',
        icon: Play,
        action: () => startFocus('pomodoro')
      },
      {
        id: 'stopwatch',
        label: '开始自由计时',
        detail: '正计时',
        icon: TimerReset,
        action: () => startFocus('stopwatch')
      },
      {
        id: 'settings',
        label: '打开设置与备份',
        detail: '目标、提醒、AI 与同步',
        icon: Settings,
        action: openSettings
      },
      {
        id: 'export',
        label: '导出 JSON 备份',
        detail: '保存全部本地数据',
        icon: Download,
        action: async () => {
          const result = await api.backup.exportJson()
          if (!result.canceled) showToast({ message: '备份已导出', detail: result.path })
        }
      }
    ],
    [minutes, openSettings, setView, showToast, startFocus]
  )
  const results = useMemo<Result[]>(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    const matchedTasks: Result[] = normalized
      ? flattenTasks(tasks)
          .filter((task) => task.status !== 'deleted' && matchesTask(task, normalized))
          .map((task) => ({
            id: `task-${task.id}`,
            label: task.title,
            detail:
              [task.notes, ...task.tags.map((tag) => `#${tag.name}`)]
                .filter(Boolean)
                .join(' · ')
                .slice(0, 120) || (task.scheduledFor ? `计划 ${task.scheduledFor}` : '未安排日期'),
            icon: task.status === 'completed' ? CheckCircle2 : Circle,
            completed: task.status === 'completed',
            action: () => selectTask(task.id)
          }))
      : []
    return [
      ...matchedTasks,
      ...commands.filter((command) =>
        `${command.label} ${command.detail}`.toLocaleLowerCase('zh-CN').includes(normalized)
      )
    ]
  }, [commands, query, tasks, selectTask])
  useEffect(() => {
    if (!open) {
      dialog.current?.close()
      return
    }
    setQuery('')
    setActive(0)
    dialog.current?.showModal()
    inputRef.current?.focus()
  }, [open])
  useEffect(() => {
    document.getElementById(`search-result-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  const run = async (result: Result | undefined): Promise<void> => {
    if (!result) return
    dialog.current?.close()
    setOpen(false)
    try {
      await result.action()
    } catch (error) {
      showToast({ tone: 'error', message: '操作未完成', detail: String(error) })
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="command-dialog"
      aria-label="搜索任务与命令"
      onCancel={(event) => {
        event.preventDefault()
        setOpen(false)
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}
    >
      <section className="command-palette">
        <div className="command-search">
          <Search size={18} aria-hidden="true" />
          <label className="sr-only" htmlFor="command-search-input">
            搜索全部任务或命令
          </label>
          <input
            ref={inputRef}
            id="command-search-input"
            role="combobox"
            aria-expanded={open}
            aria-controls="search-results"
            aria-autocomplete="list"
            aria-activedescendant={results[active] ? `search-result-${active}` : undefined}
            value={query}
            placeholder="搜索标题、备注或标签…"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((index) =>
                  Math.max(
                    0,
                    Math.min(results.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
                  )
                )
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                void run(results[active])
              }
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="关闭搜索"
            onClick={() => setOpen(false)}
          >
            <X size={17} />
          </button>
        </div>
        <div className="command-results" id="search-results" role="listbox" aria-label="搜索结果">
          {results.length ? (
            results.map((result, index) => {
              const Icon = result.icon
              return (
                <button
                  type="button"
                  tabIndex={-1}
                  id={`search-result-${index}`}
                  key={result.id}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? 'is-active' : ''}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void run(result)}
                >
                  <span className="command-icon">
                    <Icon size={16} />
                  </span>
                  <span className="command-result-copy">
                    <strong>{result.label}</strong>
                    <small>{result.detail}</small>
                  </span>
                  {result.completed && <span className="search-completed">已完成</span>}
                </button>
              )
            })
          ) : (
            <div className="command-empty">没有找到匹配的任务或命令。试试更短的关键词。</div>
          )}
        </div>
        <footer className="command-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>选择
          </span>
          <span>
            <kbd>Enter</kbd>打开
          </span>
          <span>包含已完成任务</span>
        </footer>
      </section>
    </dialog>,
    document.body
  )
}
