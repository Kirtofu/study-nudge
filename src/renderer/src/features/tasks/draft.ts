import type { Task, UpdateTaskInput } from '@shared/types'

type Editable = Pick<
  Task,
  | 'title'
  | 'notes'
  | 'listId'
  | 'scheduledFor'
  | 'dueAt'
  | 'reminderAt'
  | 'priority'
  | 'estimateMinutes'
>
export type TaskDraft = Editable & { tagText: string }
export type DraftSnapshot = {
  value: TaskDraft
  status: 'saved' | 'pending' | 'saving' | 'error'
  error: string
}
const fromTask = (task: Task): TaskDraft => ({
  title: task.title,
  notes: task.notes,
  listId: task.listId,
  scheduledFor: task.scheduledFor,
  dueAt: task.dueAt,
  reminderAt: task.reminderAt,
  priority: task.priority,
  estimateMinutes: task.estimateMinutes,
  tagText: task.tags.map((tag) => tag.name).join(', ')
})

// Keep edits until the particular version of each field has been acknowledged.
// A response to an earlier save never replaces text typed while it was in flight.
export function createTaskDraft(task: Task, save: (input: UpdateTaskInput) => Promise<Task>) {
  let snapshot: DraftSnapshot = { value: fromTask(task), status: 'saved', error: '' }
  let version = 0
  const dirty = new Map<keyof TaskDraft, number>()
  const listeners = new Set<() => void>()
  let running: Promise<boolean> | null = null
  const publish = (next: DraftSnapshot): void => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }
  const flush = (): Promise<boolean> => {
    if (running) return running.then((ok) => (ok && dirty.size ? flush() : ok))
    if (!dirty.size) return Promise.resolve(true)
    const fields = new Map(dirty)
    const input: UpdateTaskInput = {}
    for (const key of fields.keys()) {
      if (key === 'tagText')
        input.tagNames = [
          ...new Set(
            snapshot.value.tagText
              .split(/[,，]/)
              .map((name) => name.trim())
              .filter(Boolean)
          )
        ]
      else Object.assign(input, { [key]: snapshot.value[key] })
    }
    if (input.title !== undefined && !input.title.trim()) {
      publish({ ...snapshot, status: 'error', error: '标题还没写完，请填写后重试。' })
      return Promise.resolve(false)
    }
    publish({ ...snapshot, status: 'saving', error: '' })
    running = save(input)
      .then((saved) => {
        for (const [key, revision] of fields) if (dirty.get(key) === revision) dirty.delete(key)
        const value = fromTask(saved)
        for (const key of dirty.keys()) Object.assign(value, { [key]: snapshot.value[key] })
        publish({ value, status: dirty.size ? 'pending' : 'saved', error: '' })
        return true
      })
      .catch((error: unknown) => {
        publish({
          ...snapshot,
          status: 'error',
          error: error instanceof Error ? error.message : '更改没有保存，请重试。'
        })
        return false
      })
      .finally(() => {
        running = null
      })
    return running
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    edit<K extends keyof TaskDraft>(key: K, value: TaskDraft[K]): void {
      dirty.set(key, ++version)
      publish({
        value: { ...snapshot.value, [key]: value },
        status: running ? 'saving' : 'pending',
        error: ''
      })
    },
    receive(incoming: Task): void {
      const value = fromTask(incoming)
      for (const key of dirty.keys()) Object.assign(value, { [key]: snapshot.value[key] })
      if (JSON.stringify(value) !== JSON.stringify(snapshot.value)) publish({ ...snapshot, value })
    },
    flush
  }
}
