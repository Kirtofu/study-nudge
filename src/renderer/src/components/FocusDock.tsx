import {
  Coffee,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Square,
  TimerReset
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, isTauri } from '../bridge'
import { findTask } from '../features/tasks/model'
import { useNudgeStore } from '../store'
import { formatDuration, formatTimer, getElapsedFocusSeconds } from '../utils'

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [active])
  return now
}

export function FocusDock(): React.JSX.Element {
  const focusState = useNudgeStore((state) => state.focusState)
  const busy = useNudgeStore((state) => state.focusBusy)
  const focusStats = useNudgeStore((state) => state.focusStats)
  const settings = useNudgeStore((state) => state.settings)
  const tasks = useNudgeStore((state) => state.tasks)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const pauseFocus = useNudgeStore((state) => state.pauseFocus)
  const resumeFocus = useNudgeStore((state) => state.resumeFocus)
  const stopFocus = useNudgeStore((state) => state.stopFocus)
  const skipFocus = useNudgeStore((state) => state.skipFocus)
  const now = useNow(focusState?.status === 'running')

  const linkedTask = useMemo(
    () => findTask(tasks, focusState?.taskId ?? null),
    [focusState?.taskId, tasks]
  )

  if (!focusState || focusState.status === 'idle') {
    const today = focusStats?.todaySeconds ?? 0
    const goal = Math.max(60, (focusStats?.dailyGoalMinutes ?? 120) * 60)
    return (
      <section className="focus-dock is-idle" aria-label="专注计时">
        <div className="focus-idle-copy">
          <span className="focus-dock-icon" aria-hidden="true">
            <TimerReset size={18} />
          </span>
          <div>
            <strong>让下一步安静下来</strong>
            <small>
              今天已专注 {formatDuration(today)} · {Math.round((today / goal) * 100)}%
            </small>
          </div>
        </div>
        <div className="focus-dock-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void startFocus('stopwatch')}
          >
            <Play size={14} fill="currentColor" aria-hidden="true" />
            自由计时
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void startFocus('pomodoro')}
          >
            <Play size={14} fill="currentColor" aria-hidden="true" />
            {settings?.pomodoroFocusMinutes ?? 25} 分钟专注
          </button>
        </div>
      </section>
    )
  }

  const elapsed = getElapsedFocusSeconds(focusState, now)
  const remaining = focusState.durationSeconds
    ? Math.max(0, focusState.durationSeconds - elapsed)
    : elapsed
  const progress = focusState.durationSeconds
    ? Math.min(1, elapsed / focusState.durationSeconds)
    : 0

  return (
    <section className={`focus-dock is-active phase-${focusState.phase}`} aria-label="正在计时">
      <div className="focus-progress-track" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="focus-active-copy">
        <span className="focus-dock-icon" aria-hidden="true">
          {focusState.phase === 'break' ? <Coffee size={18} /> : <TimerReset size={18} />}
        </span>
        <div>
          <span className="focus-phase">
            {focusState.phase === 'break'
              ? '休息一下'
              : focusState.mode === 'pomodoro'
                ? '正在专注'
                : '自由计时'}
          </span>
          <strong>
            {linkedTask?.title ??
              (focusState.phase === 'break' ? '离开屏幕，活动一下' : '未关联任务')}
          </strong>
        </div>
      </div>
      <time className="focus-time" aria-live="off">
        {formatTimer(remaining)}
      </time>
      <div className="focus-dock-actions">
        <button
          type="button"
          className="icon-button focus-control"
          disabled={busy}
          aria-label={focusState.status === 'paused' ? '继续计时' : '暂停计时'}
          onClick={() => void (focusState.status === 'paused' ? resumeFocus() : pauseFocus())}
        >
          {focusState.status === 'paused' ? (
            <Play size={15} fill="currentColor" />
          ) : (
            <Pause size={15} fill="currentColor" />
          )}
        </button>
        {focusState.mode === 'pomodoro' ? (
          <button
            type="button"
            className="icon-button focus-control"
            disabled={busy}
            aria-label="跳过当前阶段"
            onClick={() => void skipFocus()}
          >
            <SkipForward size={15} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button focus-control"
          disabled={busy}
          aria-label="结束计时"
          onClick={() => void stopFocus()}
        >
          <Square size={14} fill="currentColor" aria-hidden="true" />
        </button>
        {isTauri && !/Android|iPhone|iPad/i.test(navigator.userAgent) && (
          <button
            type="button"
            className="icon-button focus-control desktop-focus-control"
            aria-label="打开专注迷你窗"
            onClick={() => void api.desktop.toggleMiniWindow()}
          >
            <Maximize2 size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  )
}

export function MiniFocus(): React.JSX.Element {
  const focusState = useNudgeStore((state) => state.focusState)
  const busy = useNudgeStore((state) => state.focusBusy)
  const settings = useNudgeStore((state) => state.settings)
  const tasks = useNudgeStore((state) => state.tasks)
  const startFocus = useNudgeStore((state) => state.startFocus)
  const pauseFocus = useNudgeStore((state) => state.pauseFocus)
  const resumeFocus = useNudgeStore((state) => state.resumeFocus)
  const stopFocus = useNudgeStore((state) => state.stopFocus)
  const skipFocus = useNudgeStore((state) => state.skipFocus)
  const now = useNow(focusState?.status === 'running')
  const task = findTask(tasks, focusState?.taskId ?? null)

  if (!focusState || focusState.status === 'idle') {
    return (
      <main className="mini-focus mini-idle">
        <div className="mini-brand">
          <span className="brand-mark">
            <TimerReset size={14} />
          </span>
          <strong>Nudge 专注</strong>
        </div>
        <h1>准备好安静做一件事了吗？</h1>
        <div className="mini-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void startFocus('stopwatch')}
          >
            <RotateCcw size={14} />
            自由计时
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void startFocus('pomodoro')}
          >
            <Play size={14} fill="currentColor" />
            开始 {settings?.pomodoroFocusMinutes ?? 25} 分钟
          </button>
        </div>
      </main>
    )
  }

  const elapsed = getElapsedFocusSeconds(focusState, now)
  const remaining = focusState.durationSeconds
    ? Math.max(0, focusState.durationSeconds - elapsed)
    : elapsed
  const progress = focusState.durationSeconds
    ? Math.min(1, elapsed / focusState.durationSeconds)
    : 0

  return (
    <main className="mini-focus mini-running">
      <div className="mini-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
      <div className="mini-topline">
        <span>{focusState.phase === 'break' ? '休息中' : '正在专注'}</span>
        <button
          type="button"
          className="mini-link"
          onClick={() => void api.desktop.showMainWindow()}
        >
          打开主窗口
        </button>
      </div>
      <time>{formatTimer(remaining)}</time>
      <p>
        {task?.title ??
          (focusState.phase === 'break'
            ? '离开屏幕，活动一下'
            : focusState.mode === 'pomodoro'
              ? '番茄专注'
              : '自由专注')}
      </p>
      <div className="mini-controls">
        <button
          type="button"
          className="icon-button"
          aria-label={focusState.status === 'paused' ? '继续' : '暂停'}
          disabled={busy}
          onClick={() => void (focusState.status === 'paused' ? resumeFocus() : pauseFocus())}
        >
          {focusState.status === 'paused' ? (
            <Play size={16} fill="currentColor" />
          ) : (
            <Pause size={16} fill="currentColor" />
          )}
        </button>
        {focusState.mode === 'pomodoro' ? (
          <button
            type="button"
            className="icon-button"
            aria-label="跳过"
            disabled={busy}
            onClick={() => void skipFocus()}
          >
            <SkipForward size={16} />
          </button>
        ) : null}
        <button
          type="button"
          className="icon-button mini-stop"
          aria-label="结束"
          disabled={busy}
          onClick={() => void stopFocus()}
        >
          <Square size={15} fill="currentColor" />
        </button>
      </div>
    </main>
  )
}
