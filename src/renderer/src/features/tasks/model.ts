import type { EntityChangeSet, Tag, Task, TaskOrderPatch, ViewId } from '@shared/types'
import { format, parseISO } from 'date-fns'

export function localDay(date = new Date()): string {
  return format(date, 'yyyy-MM-dd')
}
export function flattenTasks(tasks: Task[]): Task[] {
  return tasks.flatMap((task) => [task, ...flattenTasks(task.subtasks)])
}
export function findTask(tasks: Task[], id: string | null): Task | undefined {
  return id ? flattenTasks(tasks).find((task) => task.id === id) : undefined
}
export function taskDay(iso: string | null): string | null {
  if (!iso) return null
  const date = parseISO(iso)
  return Number.isNaN(date.getTime()) ? null : localDay(date)
}
export function isCarriedTask(task: Task, today: string): boolean {
  const due = taskDay(task.dueAt)
  return Boolean((task.scheduledFor && task.scheduledFor < today) || (due && due < today))
}
export function matchesTask(task: Task, search: string): boolean {
  const query = search.trim().toLocaleLowerCase('zh-CN')
  return (
    !query ||
    [task.title, task.notes, ...task.tags.map((tag) => tag.name)].some((value) =>
      value.toLocaleLowerCase('zh-CN').includes(query)
    )
  )
}
export function filterTasks(tasks: Task[], view: ViewId, search = '', today = localDay()): Task[] {
  return tasks.filter((task) => {
    if (task.status === 'deleted' || !matchesTask(task, search)) return false
    if (view === 'completed') return task.status === 'completed'
    if (task.status !== 'open') return false
    if (view === 'today')
      return (
        task.scheduledFor === today || taskDay(task.dueAt) === today || isCarriedTask(task, today)
      )
    if (view === 'inbox') return task.scheduledFor === null
    if (view === 'upcoming') return Boolean(task.scheduledFor && task.scheduledFor > today)
    return task.listId === view.slice(5)
  })
}

export function taskGroups(
  tasks: Task[],
  view: ViewId,
  today: string
): Array<{ label: string; tasks: Task[] }> {
  if (view === 'today')
    return [
      { label: '此前未完成', tasks: tasks.filter((task) => isCarriedTask(task, today)) },
      { label: '今天安排', tasks: tasks.filter((task) => !isCarriedTask(task, today)) }
    ].filter((group) => group.tasks.length)
  if (view === 'upcoming')
    return [...new Set(tasks.map((task) => task.scheduledFor!))]
      .sort()
      .map((day) => ({ label: day, tasks: tasks.filter((task) => task.scheduledFor === day) }))
  return [{ label: view === 'completed' ? '完成记录' : '待办事项', tasks }]
}

export function taskMap(tasks: Task[]): Map<string, Task> {
  return new Map(flattenTasks(tasks).map((task) => [task.id, { ...task, subtasks: [] }]))
}
export function taskTree(entities: Map<string, Task>): Task[] {
  const nodes = new Map(
    [...entities]
      .filter(([, task]) => task.status !== 'deleted')
      .map(([id, task]) => [id, { ...task, subtasks: [] as Task[] }])
  )
  const roots: Task[] = []
  for (const task of nodes.values()) {
    if (task.parentId) nodes.get(task.parentId)?.subtasks.push(task)
    else roots.push(task)
  }
  const sort = (tasks: Task[]): Task[] =>
    tasks
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id)
      )
      .map((task) => ({ ...task, subtasks: sort(task.subtasks) }))
  return sort(roots)
}
export function applyChanges(entities: Map<string, Task>, changes: EntityChangeSet): void {
  for (const id of changes.removedTaskIds) entities.delete(id)
  for (const task of flattenTasks(changes.upsertedTasks))
    entities.set(task.id, { ...task, subtasks: [] })
}
export function applyOrder(entities: Map<string, Task>, patches: TaskOrderPatch[]): void {
  for (const patch of patches) {
    const task = entities.get(patch.id)
    if (task) entities.set(task.id, { ...task, position: patch.position })
  }
}
export function reorderSlots(tasks: Task[], ids: string[]): TaskOrderPatch[] {
  const selected = new Set(ids)
  if (!ids.length) return []
  if (selected.size !== ids.length) throw new Error('排序包含重复任务')
  const parentId = findTask(tasks, ids[0])?.parentId
  const siblings = flattenTasks(tasks)
    .filter((task) => task.parentId === parentId && task.status !== 'deleted')
    .sort(
      (a, b) =>
        a.position - b.position ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id)
    )
  if (siblings.filter((task) => selected.has(task.id)).length !== ids.length)
    throw new Error('只能排序同一层级中存在的任务')
  let index = 0
  return siblings.map((task, position) => ({
    id: selected.has(task.id) ? ids[index++] : task.id,
    position: (position + 1) * 1000
  }))
}
export function mergeTags(tags: Tag[], added: Tag[]): Tag[] {
  return [...new Map([...tags, ...added].map((tag) => [tag.id, tag])).values()].sort((a, b) =>
    a.name.localeCompare(b.name, 'zh-CN')
  )
}
