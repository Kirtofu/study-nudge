import type { Task } from '@shared/types'
import { expect, it, vi } from 'vitest'
import { createTaskDraft } from './draft'
import { deferred, task } from './test-fixtures'

it('preserves newer text when an older save responds and then persists the newer version', async () => {
  const response = deferred<Task>()
  const save = vi
    .fn()
    .mockReturnValueOnce(response.promise)
    .mockResolvedValueOnce(task('a', { title: 'latest' }))
  const draft = createTaskDraft(task('a'), save)
  draft.edit('title', 'earlier')
  const saving = draft.flush()
  draft.edit('title', 'latest')
  draft.edit('notes', 'still typing')
  response.resolve(task('a', { title: 'earlier' }))
  await saving
  expect(draft.getSnapshot().value.title).toBe('latest')
  expect(draft.getSnapshot().value.notes).toBe('still typing')
  await draft.flush()
  expect(save).toHaveBeenLastCalledWith({ title: 'latest', notes: 'still typing' })
})
it('keeps failed edits available for retry and sends explicit null for cleared dates', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValueOnce(task('a'))
  const draft = createTaskDraft(task('a', { scheduledFor: '2026-09-13' }), save)
  draft.edit('scheduledFor', null)
  expect(await draft.flush()).toBe(false)
  expect(draft.getSnapshot().status).toBe('error')
  expect(draft.getSnapshot().value.scheduledFor).toBeNull()
  expect(await draft.flush()).toBe(true)
  expect(save).toHaveBeenLastCalledWith({ scheduledFor: null })
})
it('merges remote changes into clean fields without overwriting dirty fields', () => {
  const draft = createTaskDraft(task('a'), vi.fn())
  draft.edit('notes', 'local draft')
  draft.receive(task('a', { title: 'remote title', notes: 'remote notes' }))
  expect(draft.getSnapshot().value).toMatchObject({ title: 'remote title', notes: 'local draft' })
})
it('isolates drafts for two tasks and flushes text entered during an in-flight close', async () => {
  const response = deferred<Task>()
  const save = vi
    .fn()
    .mockReturnValueOnce(response.promise)
    .mockResolvedValueOnce(task('a', { title: 'final' }))
  const a = createTaskDraft(task('a'), save)
  const b = createTaskDraft(task('b'), vi.fn())
  a.edit('title', 'old')
  const first = a.flush()
  a.edit('title', 'final')
  const close = a.flush()
  b.edit('title', 'other task')
  response.resolve(task('a', { title: 'old' }))
  await first
  await close
  expect(a.getSnapshot().value.title).toBe('final')
  expect(b.getSnapshot().value.title).toBe('other task')
  expect(save).toHaveBeenCalledTimes(2)
})
