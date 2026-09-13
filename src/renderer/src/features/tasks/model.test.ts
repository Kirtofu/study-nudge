import { describe, expect, it } from 'vitest'
import { filterTasks, flattenTasks, localDay, matchesTask, reorderSlots, taskGroups } from './model'
import { task } from './test-fixtures'

describe('daily task model', () => {
  it('carries earlier plans across midnight without changing their original date', () => {
    const earlier = task('earlier', { scheduledFor: '2026-09-12' })
    const current = task('current', { scheduledFor: '2026-09-13' })
    const future = task('future', { scheduledFor: '2026-09-14' })
    const done = task('done', { scheduledFor: '2026-09-12', status: 'completed' })
    expect(filterTasks([earlier, current, future, done], 'today', '', '2026-09-13')).toEqual([
      earlier,
      current
    ])
    expect(
      taskGroups([earlier, current], 'today', '2026-09-13').map((group) => [
        group.label,
        group.tasks.map((item) => item.id)
      ])
    ).toEqual([
      ['此前未完成', ['earlier']],
      ['今天安排', ['current']]
    ])
    expect(taskGroups([earlier, current], 'today', '2026-09-14')[0].tasks).toHaveLength(2)
    expect(earlier.scheduledFor).toBe('2026-09-12')
    expect(localDay(new Date(2026, 8, 14, 0, 1))).toBe('2026-09-14')
  })
  it('clearing the plan returns a task to the inbox and deadlines still surface today', () => {
    expect(filterTasks([task('clear')], 'inbox')).toHaveLength(1)
    const due = task('due', { dueAt: new Date(2026, 8, 12, 18).toISOString() })
    expect(filterTasks([due], 'today', '', '2026-09-13')).toHaveLength(1)
  })
  it('finds notes, tags and nested completed tasks', () => {
    const nested = task('nested', {
      status: 'completed',
      notes: 'HTTPS WebDAV',
      tags: [{ id: 'rust', name: 'Rust', color: '#c96442' }]
    })
    expect(flattenTasks([task('root', { subtasks: [nested] })])).toContain(nested)
    expect(matchesTask(nested, 'webdav')).toBe(true)
    expect(matchesTask(nested, 'RUST')).toBe(true)
  })
  it('reorders selected slots while preserving hidden siblings', () => {
    const tasks = ['a', 'hidden', 'b', 'later'].map((id, i) => task(id, { position: i * 1000 }))
    expect(reorderSlots(tasks, ['b', 'a']).map((patch) => patch.id)).toEqual([
      'b',
      'hidden',
      'a',
      'later'
    ])
    expect(() => reorderSlots(tasks, ['a', 'a'])).toThrow()
    expect(() => reorderSlots(tasks, ['missing'])).toThrow()
  })
})
