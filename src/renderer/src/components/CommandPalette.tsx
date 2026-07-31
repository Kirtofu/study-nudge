import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  CalendarDays,
  CheckCircle2,
  Download,
  Inbox,
  ListPlus,
  Maximize2,
  Play,
  Search,
  Settings,
  SunMedium,
  TimerReset
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../bridge'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

type CommandItem = {
  id: string
  label: string
  detail: string
  icon: LucideIcon
  keywords: string
  action: () => void | Promise<void>
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useNudgeStore((state) => state.commandOpen)
  const setOpen = useNudgeStore((state) => state.setCommandOpen)
  const setView = useNudgeStore((state) => state.setView)
  const openSettings = useNudgeStore((state) => state.openSettings)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const showToast = useToast()

  const commands = useMemo<CommandItem[]>(
    () => [
      {
        id: 'new-task',
        label: '添加新任务',
        detail: 'Ctrl+N',
        icon: ListPlus,
        keywords: '新建 添加 任务 todo',
        action: () => {
          setOpen(false)
          window.setTimeout(() => document.getElementById('quick-add-input')?.focus(), 0)
        }
      },
      { id: 'today', label: '打开今天', detail: '查看今天与逾期任务', icon: SunMedium, keywords: '今天 今日', action: () => setView('today') },
      { id: 'inbox', label: '打开收集箱', detail: '尚未安排日期的任务', icon: Inbox, keywords: '收集箱 inbox', action: () => setView('inbox') },
      { id: 'upcoming', label: '打开计划', detail: '未来安排', icon: CalendarDays, keywords: '计划 未来 upcoming', action: () => setView('upcoming') },
      { id: 'completed', label: '查看已完成', detail: '回顾完成记录', icon: CheckCircle2, keywords: '已完成 完成', action: () => setView('completed') },
      { id: 'pomodoro', label: '开始 25 分钟专注', detail: '番茄钟', icon: Play, keywords: '专注 番茄 25', action: () => startFocus('pomodoro') },
      { id: 'stopwatch', label: '开始自由计时', detail: '正计时', icon: TimerReset, keywords: '自由 计时 stopwatch', action: () => startFocus('stopwatch') },
      { id: 'mini', label: '切换专注迷你窗', detail: '置顶显示', icon: Maximize2, keywords: '迷你 窗口', action: () => api.desktop.toggleMiniWindow() },
      { id: 'settings', label: '打开设置与备份', detail: '目标、提醒与数据', icon: Settings, keywords: '设置 备份', action: openSettings },
      {
        id: 'export',
        label: '导出 JSON 备份',
        detail: '保存全部本地数据',
        icon: Download,
        keywords: '导出 备份 json',
        action: async () => {
          const result = await api.backup.exportJson()
          if (!result.canceled) showToast({ message: '备份已经导出', detail: result.path })
        }
      }
    ],
    [openSettings, setOpen, setView, showToast, startFocus]
  )

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    if (!normalized) return commands
    return commands.filter((command) =>
      `${command.label} ${command.detail} ${command.keywords}`.toLocaleLowerCase('zh-CN').includes(normalized)
    )
  }, [commands, query])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(!open)
      }
      if (event.key === 'Escape' && open) setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  useEffect(() => setActiveIndex(0), [query])

  const run = (command: CommandItem | undefined): void => {
    if (!command) return
    setOpen(false)
    void command.action()
  }

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="command-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}
        >
          <motion.section
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="命令面板"
            initial={{ opacity: 0, y: -12, scale: 0.98, filter: 'blur(3px)' }}
            animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -7, scale: 0.985 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="command-search">
              <Search size={18} aria-hidden="true" />
              <label className="sr-only" htmlFor="command-search-input">
                搜索命令
              </label>
              <input
                ref={inputRef}
                id="command-search-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="输入要做的事…"
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    setActiveIndex((index) => Math.min(filtered.length - 1, index + 1))
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    setActiveIndex((index) => Math.max(0, index - 1))
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    run(filtered[activeIndex])
                  }
                }}
              />
              <kbd>Esc</kbd>
            </div>
            <div className="command-results" role="listbox" aria-label="命令结果">
              {filtered.length ? (
                filtered.map((command, index) => {
                  const Icon = command.icon
                  return (
                    <button
                      type="button"
                      key={command.id}
                      className={index === activeIndex ? 'is-active' : ''}
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => run(command)}
                    >
                      <span className="command-icon"><Icon size={16} aria-hidden="true" /></span>
                      <span><strong>{command.label}</strong><small>{command.detail}</small></span>
                    </button>
                  )
                })
              ) : (
                <div className="command-empty">没有匹配的命令，试试“今天”或“专注”。</div>
              )}
            </div>
            <footer className="command-footer">
              <span><kbd>↑</kbd><kbd>↓</kbd>选择</span>
              <span><kbd>Enter</kbd>执行</span>
            </footer>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  )
}
