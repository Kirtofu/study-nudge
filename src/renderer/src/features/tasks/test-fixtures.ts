import type { Task, TaskMutationResult } from '@shared/types'

export const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: id,
  notes: '',
  listId: 'inbox',
  parentId: null,
  status: 'open',
  scheduledFor: null,
  dueAt: null,
  reminderAt: null,
  priority: 'none',
  estimateMinutes: null,
  position: 1000,
  completedAt: null,
  deletedAt: null,
  createdAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
  tags: [],
  subtasks: [],
  ...patch
})
export const changed = (value: Task): TaskMutationResult => ({
  task: value,
  changes: { upsertedTasks: [value], removedTaskIds: [], upsertedTags: value.tags }
})
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
