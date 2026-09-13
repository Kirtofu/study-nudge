import type { Task, TaskMutationResult } from '@shared/types'
import { expect, it, vi } from 'vitest'
import { applyOrder } from './model'
import { createTaskMutations } from './mutations'
import { changed, deferred, task } from './test-fixtures'

function harness() {
  let visible: Task[] = []
  const mutations = createTaskMutations((tasks) => {
    visible = tasks
  })
  mutations.hydrate([task('a'), task('b', { position: 2000 })])
  return { mutations, visible: () => visible }
}
it('a failed task operation never rolls back a different task that succeeded', async () => {
  const h = harness()
  const one = deferred<TaskMutationResult>()
  const two = deferred<TaskMutationResult>()
  const first = h.mutations
    .enqueue(
      ['a'],
      (map) => map.set('a', task('a', { status: 'completed' })),
      () => one.promise
    )
    .catch(() => undefined)
  const second = h.mutations.enqueue(
    ['b'],
    (map) => map.set('b', task('b', { notes: 'new' })),
    () => two.promise
  )
  two.resolve(changed(task('b', { notes: 'saved', position: 2000 })))
  await second
  one.reject(new Error('disk unavailable'))
  await first
  expect(h.visible().find((item) => item.id === 'a')?.status).toBe('open')
  expect(h.visible().find((item) => item.id === 'b')?.notes).toBe('saved')
})
it('serializes writes to the same task while keeping its newer optimistic text', async () => {
  const h = harness()
  const firstResult = deferred<TaskMutationResult>()
  const later = vi.fn(async () => changed(task('a', { notes: 'newer' })))
  const first = h.mutations.enqueue(
    ['a'],
    (map) => map.set('a', task('a', { notes: 'earlier' })),
    () => firstResult.promise
  )
  const second = h.mutations.enqueue(
    ['a'],
    (map) => map.set('a', task('a', { notes: 'newer' })),
    later
  )
  expect(later).not.toHaveBeenCalled()
  firstResult.resolve(changed(task('a', { notes: 'earlier' })))
  await first
  expect(h.visible()[0].notes).toBe('newer')
  await second
  expect(later).toHaveBeenCalledOnce()
})
it('includes parent and children in a serial lane', () => {
  const h = harness()
  h.mutations.hydrate([task('parent', { subtasks: [task('child', { parentId: 'parent' })] })])
  expect(h.mutations.keysFor('child')).toEqual(expect.arrayContaining(['parent', 'child']))
})
it('keeps order patches when an edit follows a drag', async () => {
  const h = harness()
  const order = [
    { id: 'b', position: 1000 },
    { id: 'a', position: 2000 }
  ]
  await h.mutations.enqueue(
    ['a', 'b'],
    (map) => applyOrder(map, order),
    async () => ({ order })
  )
  await h.mutations.enqueue(
    ['a'],
    () => undefined,
    async () => changed(task('a', { title: 'edited', position: 2000 }))
  )
  expect(h.visible().map((item) => item.id)).toEqual(['b', 'a'])
})
