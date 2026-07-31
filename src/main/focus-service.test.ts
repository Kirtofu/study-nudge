import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NudgeDatabase } from './database'
import { elapsedSeconds, FocusService } from './focus-service'

const temporaryDirectories: string[] = []

function createDatabase(): NudgeDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'nudge-focus-'))
  temporaryDirectories.push(directory)
  return new NudgeDatabase(join(directory, 'nudge.db'), [])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-31T08:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('FocusService', () => {
  it('uses timestamps to recover an expired Pomodoro after sleep or restart', () => {
    const database = createDatabase()
    database.setFocusState({
      status: 'running',
      mode: 'pomodoro',
      phase: 'focus',
      taskId: null,
      startedAt: '2026-07-31T07:34:00.000Z',
      accumulatedSeconds: 0,
      durationSeconds: 1500
    })
    const notify = vi.fn()
    const service = new FocusService(database, notify)

    expect(service.getState()).toMatchObject({ status: 'running', phase: 'break' })
    expect(database.getFocusStats().sessions[0]?.durationSeconds).toBe(1500)
    expect(notify).toHaveBeenCalledWith('这一轮专注完成', '先松一口气，休息计时已经开始。')

    service.dispose()
    database.close()
  })

  it('continues a recovered stopwatch and saves its real elapsed duration', () => {
    const database = createDatabase()
    database.setFocusState({
      status: 'running',
      mode: 'stopwatch',
      phase: 'focus',
      taskId: null,
      startedAt: '2026-07-31T07:57:55.000Z',
      accumulatedSeconds: 0,
      durationSeconds: null
    })
    const service = new FocusService(database, vi.fn())

    expect(elapsedSeconds(service.getState())).toBe(125)
    service.stop()
    expect(database.getFocusStats().sessions[0]?.durationSeconds).toBe(125)
    expect(database.getFocusState().status).toBe('idle')

    service.dispose()
    database.close()
  })
})
