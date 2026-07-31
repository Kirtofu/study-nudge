import { format, isBefore, isSameDay, parseISO, startOfDay } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import type { FocusState, Task, ViewId } from '@shared/types'

export function dateKey(date = new Date()): string {
  return format(date, 'yyyy-MM-dd')
}

export function formatFriendlyDate(date = new Date()): string {
  return format(date, 'M月d日 EEEE', { locale: zhCN })
}

export function formatClock(iso: string | null): string {
  if (!iso) return ''
  return format(parseISO(iso), 'HH:mm')
}

export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  if (hours > 0) return `${hours}小时${minutes ? ` ${minutes}分钟` : ''}`
  return `${minutes}分钟`
}

export function formatTimer(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const remaining = safe % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
}

export function getElapsedFocusSeconds(state: FocusState, now = Date.now()): number {
  if (state.status !== 'running' || !state.startedAt) return state.accumulatedSeconds
  return state.accumulatedSeconds + Math.max(0, Math.floor((now - parseISO(state.startedAt).getTime()) / 1000))
}

export function filterTasks(tasks: Task[], view: ViewId, search: string): Task[] {
  const query = search.trim().toLocaleLowerCase('zh-CN')
  const today = dateKey()
  return tasks.filter((task) => {
    if (task.status === 'deleted') return false
    const matchesSearch =
      !query ||
      task.title.toLocaleLowerCase('zh-CN').includes(query) ||
      task.notes.toLocaleLowerCase('zh-CN').includes(query) ||
      task.tags.some((tag) => tag.name.toLocaleLowerCase('zh-CN').includes(query))
    if (!matchesSearch) return false
    if (view === 'completed') return task.status === 'completed'
    if (task.status !== 'open') return false
    if (view === 'today') {
      if (task.scheduledFor === today) return true
      return Boolean(task.dueAt && isBefore(parseISO(task.dueAt), startOfDay(new Date())))
    }
    if (view === 'inbox') return task.scheduledFor === null
    if (view === 'upcoming') return Boolean(task.scheduledFor && task.scheduledFor > today)
    if (view.startsWith('list:')) return task.listId === view.slice(5)
    return true
  })
}

export function groupLabel(task: Task): '上午' | '下午' | '晚间' | '随时' {
  if (!task.dueAt || !isSameDay(parseISO(task.dueAt), new Date())) return '随时'
  const hour = parseISO(task.dueAt).getHours()
  if (hour < 12) return '上午'
  if (hour < 18) return '下午'
  return '晚间'
}
