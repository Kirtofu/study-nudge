import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NudgeDatabase } from './database'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'nudge-database-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('NudgeDatabase', () => {
  it('imports legacy focus records once across repeated paths and launches', () => {
    const directory = temporaryDirectory()
    const legacy = join(directory, 'data.json')
    const duplicateLegacy = join(directory, 'data-copy.json')
    const payload = [
      { date: '2026-07-30', time: '23:25', hours: 1.5, note: '写了 rmsnorm kernel' },
      { date: '2026-07-30', time: '23:25', hours: 0.5, note: '读 paged attention 论文' }
    ]
    writeFileSync(legacy, JSON.stringify(payload), 'utf8')
    writeFileSync(duplicateLegacy, JSON.stringify(payload), 'utf8')

    const databasePath = join(directory, 'nudge.db')
    const first = new NudgeDatabase(databasePath, [legacy, duplicateLegacy])
    expect(first.getFocusStats().sessions).toHaveLength(2)
    expect(first.getFocusStats().totalSeconds).toBe(7200)
    first.close()

    const reopened = new NudgeDatabase(databasePath, [legacy, duplicateLegacy])
    expect(reopened.getFocusStats().sessions).toHaveLength(2)
    expect(reopened.getFocusStats().totalSeconds).toBe(7200)
    reopened.close()
  })

  it('persists completion, tags, subtasks and manual ordering', () => {
    const directory = temporaryDirectory()
    const databasePath = join(directory, 'nudge.db')
    const database = new NudgeDatabase(databasePath, [])
    const first = database.createTask({ title: '第一项', listId: 'inbox', tagNames: ['关键'] })
    const second = database.createTask({ title: '第二项', listId: 'inbox' })
    const subtask = database.createTask({ title: '子任务', listId: 'inbox', parentId: first.id })

    database.reorderTasks([second.id, first.id])
    database.completeTask(first.id, true)
    database.close()

    const reopened = new NudgeDatabase(databasePath, [])
    const restoredFirst = reopened.getTask(first.id)
    const restoredSecond = reopened.getTask(second.id)
    expect(restoredFirst.status).toBe('completed')
    expect(restoredFirst.tags.map((tag) => tag.name)).toContain('关键')
    expect(restoredFirst.subtasks.map((task) => task.id)).toContain(subtask.id)
    expect(restoredSecond.position).toBeLessThan(restoredFirst.position)
    reopened.close()
  })

  it('merges a backup without replacing local records or breaking same-name tags', () => {
    const directory = temporaryDirectory()
    const source = new NudgeDatabase(join(directory, 'source.db'), [])
    const importedTask = source.createTask({ title: '来自备份', listId: 'study', tagNames: ['共享标签'] })
    const backup = source.exportData()
    source.close()

    const target = new NudgeDatabase(join(directory, 'target.db'), [])
    const localTask = target.createTask({ title: '本地任务', listId: 'work', tagNames: ['共享标签'] })
    expect(target.importData(backup, 'merge')).toBeGreaterThan(0)

    expect(target.getTask(localTask.id).title).toBe('本地任务')
    expect(target.getTask(importedTask.id).tags.map((tag) => tag.name)).toEqual(['共享标签'])
    expect(() => target.importData({ data: { lists: [], tasks: [{ id: 'unsafe' }] } }, 'merge')).toThrow(
      '这不是有效的 Nudge 备份文件'
    )
    target.close()
  })

  it('returns the existing row when a source key is imported twice', () => {
    const directory = temporaryDirectory()
    const database = new NudgeDatabase(join(directory, 'nudge.db'), [])
    const input = {
      taskId: null,
      mode: 'legacy' as const,
      startedAt: '2026-07-30T12:00:00.000Z',
      endedAt: '2026-07-30T13:00:00.000Z',
      durationSeconds: 3600,
      note: '旧记录',
      source: 'study-nudge',
      sourceKey: 'same-source-key'
    }

    const first = database.addFocusSession(input)
    const second = database.addFocusSession(input)
    expect(second.id).toBe(first.id)
    expect(database.getFocusStats().sessions.filter((session) => session.sourceKey === input.sourceKey)).toHaveLength(1)
    database.close()
  })
})
