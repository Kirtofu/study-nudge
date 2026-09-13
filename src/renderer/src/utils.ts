import type { FocusState } from '@shared/types'
import { format, parseISO } from 'date-fns'
import { zhCN } from 'date-fns/locale'

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
  return (
    state.accumulatedSeconds +
    Math.max(0, Math.floor((now - parseISO(state.startedAt).getTime()) / 1000))
  )
}

export { filterTasks } from './features/tasks/model'
