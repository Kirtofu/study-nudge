import type { EntityChangeSet, Tag, Task, TaskOrderPatch } from '@shared/types'
import { applyChanges, applyOrder, flattenTasks, mergeTags, taskMap, taskTree } from './model'

type Change = { changes?: EntityChangeSet; order?: TaskOrderPatch[] }
type Operation = {
  keys: Set<string>
  project: (entities: Map<string, Task>) => void
  run: () => Promise<Change>
  done: (result: Change) => void
  fail: (error: unknown) => void
  running: boolean
}

// Server state is separate from pending projections. No failure restores a whole
// list snapshot, and overlapping parent/child operations share a serial lane.
export function createTaskMutations(publish: (tasks: Task[], tags: Tag[]) => void) {
  let confirmed = new Map<string, Task>()
  let tags: Tag[] = []
  let revision = 0
  const pending: Operation[] = []
  const idleWaiters = new Set<() => void>()
  const render = (): void => {
    const visible = new Map(confirmed)
    for (const operation of pending) operation.project(visible)
    publish(taskTree(visible), tags)
  }
  const merge = (change: Change): void => {
    if (change.changes) {
      applyChanges(confirmed, change.changes)
      tags = mergeTags(tags, change.changes.upsertedTags)
    }
    if (change.order) applyOrder(confirmed, change.order)
  }
  const pump = (): void => {
    for (const [index, operation] of pending.entries()) {
      if (
        operation.running ||
        pending
          .slice(0, index)
          .some((earlier) => [...operation.keys].some((key) => earlier.keys.has(key)))
      )
        continue
      operation.running = true
      void operation.run().then(
        (result) => {
          merge(result)
          finish(operation)
          operation.done(result)
        },
        (error: unknown) => {
          finish(operation)
          operation.fail(error)
        }
      )
    }
  }
  const finish = (operation: Operation): void => {
    pending.splice(pending.indexOf(operation), 1)
    revision++
    render()
    if (!pending.length) {
      idleWaiters.forEach((done) => done())
      idleWaiters.clear()
    }
    pump()
  }
  return {
    get revision() {
      return revision
    },
    hydrate(tasks: Task[], incomingTags = tags): void {
      confirmed = taskMap(tasks)
      tags = mergeTags(
        incomingTags,
        flattenTasks(tasks).flatMap((task) => task.tags)
      )
      render()
    },
    accept(change: Change): void {
      revision++
      merge(change)
      render()
    },
    keysFor(id: string): string[] {
      const rootOf = (task: Task): string => {
        const visited = new Set<string>()
        let current = task
        while (current.parentId && confirmed.has(current.parentId) && !visited.has(current.id)) {
          visited.add(current.id)
          current = confirmed.get(current.parentId)!
        }
        return current.id
      }
      const root = confirmed.has(id) ? rootOf(confirmed.get(id)!) : id
      return [...confirmed.values()]
        .filter((task) => rootOf(task) === root)
        .map((task) => task.id)
        .concat(id)
    },
    idle(): Promise<void> {
      return pending.length ? new Promise((resolve) => idleWaiters.add(resolve)) : Promise.resolve()
    },
    enqueue(keys: string[], project: Operation['project'], run: Operation['run']): Promise<Change> {
      revision++
      return new Promise((done, fail) => {
        pending.push({ keys: new Set(keys), project, run, done, fail, running: false })
        render()
        pump()
      })
    }
  }
}
