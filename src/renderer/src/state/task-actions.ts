import type { NudgeBridge, Task, TaskMutationResult, UpdateTaskInput } from '@shared/types'
import { applyOrder, reorderSlots } from '../features/tasks/model'
import { createTaskMutations } from '../features/tasks/mutations'
import type { NudgeStore, StoreGet, StoreSet } from './types'

export function taskActions(set: StoreSet, get: StoreGet, api: NudgeBridge) {
  const mutations = createTaskMutations((tasks, tags) => set({ tasks, tags }))
  let refreshGeneration = 0
  const write = async (
    id: string,
    input: Partial<Task>,
    action: () => Promise<TaskMutationResult>
  ): Promise<Task> => {
    let returned: Task | null = null
    await mutations.enqueue(
      mutations.keysFor(id),
      (entities) => {
        const task = entities.get(id)
        if (task) entities.set(id, { ...task, ...input })
      },
      async () => {
        const result = await action()
        returned = result.task
        if (!returned) throw new Error('任务没有返回有效内容')
        return result
      }
    )
    return returned!
  }
  const actions: Pick<
    NudgeStore,
    | 'createTask'
    | 'updateTask'
    | 'completeTask'
    | 'deleteTask'
    | 'restoreTask'
    | 'reorderTasks'
    | 'refreshTasks'
    | 'createList'
    | 'updateList'
    | 'deleteList'
  > = {
    createTask: async (input) => {
      const result = input.parentId
        ? ((await mutations.enqueue(
            mutations.keysFor(input.parentId),
            () => undefined,
            () => api.tasks.create(input)
          )) as TaskMutationResult)
        : await api.tasks.create(input)
      if (!result.task) throw new Error('新任务没有返回有效内容')
      if (!input.parentId) mutations.accept(result)
      return result.task
    },
    updateTask: async (id, input: UpdateTaskInput) => {
      const { tagNames: _tagNames, ...patch } = input
      return write(id, patch, () => api.tasks.update(id, input))
    },
    completeTask: (id, completed) =>
      write(
        id,
        {
          status: completed ? 'completed' : 'open',
          completedAt: completed ? new Date().toISOString() : null
        },
        () => api.tasks.complete(id, completed)
      ),
    deleteTask: async (id) => {
      await mutations.enqueue(
        mutations.keysFor(id),
        (entities) => {
          entities.delete(id)
        },
        () => api.tasks.delete(id)
      )
      if (get().selectedTaskId === id) set({ selectedTaskId: null, drawerMode: null })
      if (get().openLearningTaskId === id) set({ openLearningTaskId: null })
    },
    restoreTask: async (id) => {
      let task: Task | null = null
      await mutations.enqueue(
        mutations.keysFor(id),
        () => undefined,
        async () => {
          const result = await api.tasks.restore(id)
          task = result.task
          return result
        }
      )
      if (!task) throw new Error('恢复任务没有返回有效内容')
      return task
    },
    reorderTasks: async (ids) => {
      const order = reorderSlots(get().tasks, ids)
      await mutations.enqueue(
        order.map((patch) => patch.id),
        (entities) => applyOrder(entities, order),
        async () => ({ order: await api.tasks.reorder(ids) })
      )
    },
    refreshTasks: async () => {
      const generation = ++refreshGeneration
      await mutations.idle()
      if (generation !== refreshGeneration) return
      const revision = mutations.revision
      const [tasks, tags] = await Promise.all([api.tasks.list(), api.tags.list()])
      if (generation !== refreshGeneration) return
      if (revision === mutations.revision) mutations.hydrate(tasks, tags)
      else await actions.refreshTasks()
    },
    createList: async (name) => {
      const list = await api.lists.create(name)
      set((state) => ({
        lists: [...state.lists.filter((item) => item.id !== list.id), list],
        currentView: `list:${list.id}`
      }))
      return list
    },
    updateList: async (id, input) => {
      const list = await api.lists.update(id, input)
      set((state) => ({ lists: state.lists.map((item) => (item.id === id ? list : item)) }))
      return list
    },
    deleteList: async (id) => {
      await mutations.idle()
      await api.lists.delete(id)
      set((state) => ({
        lists: state.lists.filter((list) => list.id !== id),
        currentView: 'inbox'
      }))
      await actions.refreshTasks()
    }
  }
  return { actions, hydrate: mutations.hydrate }
}
