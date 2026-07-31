import type { FocusState } from '../shared/types'
import { EMPTY_FOCUS_STATE, NudgeDatabase } from './database'

type FocusNotice = (title: string, body: string) => void
type FocusListener = (state: FocusState) => void

function elapsedSeconds(state: FocusState, at = Date.now()): number {
  if (state.status !== 'running' || !state.startedAt) return state.accumulatedSeconds
  const runningFor = Math.max(0, Math.floor((at - new Date(state.startedAt).getTime()) / 1000))
  return state.accumulatedSeconds + runningFor
}

export class FocusService {
  private state: FocusState
  private readonly listeners = new Set<FocusListener>()
  private readonly interval: NodeJS.Timeout

  constructor(
    private readonly database: NudgeDatabase,
    private readonly notify: FocusNotice
  ) {
    this.state = database.getFocusState()
    this.interval = setInterval(() => this.tick(), 500)
    this.tick()
  }

  dispose(): void {
    clearInterval(this.interval)
  }

  onChange(listener: FocusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): FocusState {
    return { ...this.state }
  }

  start(input: { mode: 'pomodoro' | 'stopwatch'; taskId?: string | null }): FocusState {
    if (this.state.status !== 'idle') this.finishCurrent(false)
    const settings = this.database.getSettings()
    this.state = {
      status: 'running',
      mode: input.mode,
      phase: 'focus',
      taskId: input.taskId ?? null,
      startedAt: new Date().toISOString(),
      accumulatedSeconds: 0,
      durationSeconds: input.mode === 'pomodoro' ? settings.pomodoroFocusMinutes * 60 : null
    }
    this.persistAndEmit()
    return this.getState()
  }

  pause(): FocusState {
    if (this.state.status !== 'running') return this.getState()
    this.state = {
      ...this.state,
      status: 'paused',
      accumulatedSeconds: elapsedSeconds(this.state),
      startedAt: null
    }
    this.persistAndEmit()
    return this.getState()
  }

  resume(): FocusState {
    if (this.state.status !== 'paused') return this.getState()
    this.state = {
      ...this.state,
      status: 'running',
      startedAt: new Date().toISOString()
    }
    this.persistAndEmit()
    return this.getState()
  }

  stop(): FocusState {
    this.finishCurrent(true)
    return this.getState()
  }

  skip(): FocusState {
    if (this.state.status === 'idle') return this.getState()
    if (this.state.mode === 'stopwatch') return this.stop()
    if (this.state.phase === 'focus') {
      this.finishCurrent(true, false)
      this.startBreak()
    } else {
      this.state = { ...EMPTY_FOCUS_STATE }
      this.persistAndEmit()
    }
    return this.getState()
  }

  private tick(): void {
    if (
      this.state.status !== 'running' ||
      !this.state.durationSeconds ||
      elapsedSeconds(this.state) < this.state.durationSeconds
    ) {
      return
    }

    if (this.state.phase === 'focus') {
      this.finishCurrent(true, false, this.state.durationSeconds)
      this.notify('这一轮专注完成', '先松一口气，休息计时已经开始。')
      this.startBreak()
    } else {
      this.state = { ...EMPTY_FOCUS_STATE }
      this.persistAndEmit()
      this.notify('休息结束', '准备好时，开始下一轮专注。')
    }
  }

  private startBreak(): void {
    const settings = this.database.getSettings()
    this.state = {
      status: 'running',
      mode: 'pomodoro',
      phase: 'break',
      taskId: null,
      startedAt: new Date().toISOString(),
      accumulatedSeconds: 0,
      durationSeconds: settings.pomodoroBreakMinutes * 60
    }
    this.persistAndEmit()
  }

  private finishCurrent(
    saveSession: boolean,
    reset = true,
    forcedDuration?: number
  ): void {
    const current = this.state
    const elapsed = forcedDuration ?? elapsedSeconds(current)
    if (saveSession && current.phase === 'focus' && elapsed >= 1) {
      const endedAt = new Date()
      const startedAt = new Date(endedAt.getTime() - elapsed * 1000)
      let note = '自由专注'
      if (current.taskId) {
        try {
          note = this.database.getTask(current.taskId).title
        } catch {
          note = '任务专注'
        }
      }
      this.database.addFocusSession({
        taskId: current.taskId,
        mode: current.mode,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationSeconds: elapsed,
        note,
        source: 'nudge',
        sourceKey: null
      })
    }
    if (reset) {
      this.state = { ...EMPTY_FOCUS_STATE }
      this.persistAndEmit()
    }
  }

  private persistAndEmit(): void {
    this.database.setFocusState(this.state)
    for (const listener of this.listeners) listener(this.getState())
  }
}

export { elapsedSeconds }
