import type { DataChangedEvent, Task } from '@shared/types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDemoBridge } from '../bridge/demo'
import { createTaskDraft } from '../features/tasks/draft'
import { deferred, task } from '../features/tasks/test-fixtures'
import { createNudgeStore } from '../store'

let dispose: (() => void) | undefined
beforeEach(() => {
  sessionStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 13, 23, 59, 59))
})
afterEach(() => {
  dispose?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function setup() {
  const bridge = createDemoBridge()
  const store = createNudgeStore(bridge)
  await store.getState().initialize()
  dispose = store.getState().dispose
  return { bridge, store }
}

it('refreshes local dates at midnight and again when waking from sleep', async () => {
  const { store } = await setup()
  expect(store.getState().today).toBe('2026-09-13')
  await vi.advanceTimersByTimeAsync(1100)
  expect(store.getState().today).toBe('2026-09-14')
  vi.setSystemTime(new Date(2026, 8, 16, 8))
  window.dispatchEvent(new Event('focus'))
  expect(store.getState().today).toBe('2026-09-16')
})
it('consumes affected domains from data events and removes its subscriptions', async () => {
  const { bridge, store } = await setup()
  const events: DataChangedEvent[] = []
  const off = bridge.app.onDataChanged((event) => events.push(event))
  const created = await bridge.tasks.create({ title: 'from another window' })
  await vi.advanceTimersByTimeAsync(70)
  expect(store.getState().tasks.some((item) => item.id === created.task?.id)).toBe(true)
  await bridge.settings.update({ pomodoroFocusMinutes: 40 })
  await vi.advanceTimersByTimeAsync(70)
  expect(store.getState().settings?.pomodoroFocusMinutes).toBe(40)
  expect(events).toContainEqual({ domains: ['tasks', 'tags'], source: 'local' })
  store.getState().dispose()
  off()
  await bridge.settings.update({ pomodoroFocusMinutes: 50 })
  await vi.advanceTimersByTimeAsync(100)
  expect(store.getState().settings?.pomodoroFocusMinutes).toBe(40)
})
it('ignores an earlier refresh that returns after a newer snapshot', async () => {
  const { bridge, store } = await setup()
  const old = deferred<Task[]>()
  const latest = deferred<Task[]>()
  vi.spyOn(bridge.tasks, 'list')
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise)
  const first = store.getState().refreshTasks()
  await Promise.resolve()
  const second = store.getState().refreshTasks()
  await Promise.resolve()
  latest.resolve([task('new')])
  await second
  old.resolve([task('old')])
  await first
  expect(store.getState().tasks[0].id).toBe('new')
})

it.each(['sync', 'import'] as const)(
  '%s refreshes affected data without replacing unsaved task fields',
  async (source) => {
    const bridge = createDemoBridge()
    let notify: (event: DataChangedEvent) => void = () => undefined
    vi.spyOn(bridge.app, 'onDataChanged').mockImplementation((callback) => {
      notify = callback
      return () => undefined
    })
    const store = createNudgeStore(bridge)
    await store.getState().initialize()
    dispose = store.getState().dispose
    const initial = store.getState().tasks[0]
    const draft = createTaskDraft(initial, vi.fn())
    draft.edit('notes', '尚未提交的本机草稿')
    vi.spyOn(bridge.tasks, 'list').mockResolvedValue([
      { ...initial, title: '从另一份数据更新', notes: '外部备注' }
    ])
    const off = store.subscribe((state) => draft.receive(state.tasks[0]))
    notify({ domains: ['tasks', 'tags'], source })
    await vi.advanceTimersByTimeAsync(70)
    expect(store.getState().tasks[0].title).toBe('从另一份数据更新')
    expect(draft.getSnapshot().value).toMatchObject({
      title: '从另一份数据更新',
      notes: '尚未提交的本机草稿'
    })
    off()
  }
)
it('keeps focus on duplicate starts and saves the previous task only after switching is confirmed', async () => {
  const { bridge, store } = await setup()
  await store.getState().startFocus('pomodoro', 'demo-1')
  const startedAt = store.getState().focusState?.startedAt
  vi.setSystemTime(new Date(2026, 8, 14, 0, 0, 30))
  await store.getState().startFocus('pomodoro', 'demo-1')
  expect(store.getState().focusState?.startedAt).toBe(startedAt)
  await store.getState().startFocus('stopwatch', 'demo-2')
  expect(store.getState().pendingFocus?.taskId).toBe('demo-2')
  expect((await bridge.focus.getStats()).sessions).toHaveLength(0)
  store.getState().cancelFocusSwitch()
  expect(store.getState().focusState?.taskId).toBe('demo-1')
  await store.getState().startFocus('stopwatch', 'demo-2')
  await store.getState().confirmFocusSwitch()
  const sessions = (await bridge.focus.getStats()).sessions
  expect(sessions).toHaveLength(1)
  expect(sessions[0].durationSeconds).toBe(31)
  await store.getState().stopFocus()
  await store.getState().stopFocus()
  expect((await bridge.focus.getStats()).sessions).toHaveLength(1)
})
it('demonstration persistence keeps reordered and edited tasks, including an undo after restart', async () => {
  const { bridge } = await setup()
  await bridge.tasks.delete('demo-3')
  await bridge.tasks.reorder(['demo-2', 'demo-1'])
  await bridge.tasks.update('demo-2', { notes: 'kept on restart', scheduledFor: null })
  const restarted = createDemoBridge()
  expect((await restarted.tasks.list()).slice(0, 2).map((item) => item.id)).toEqual([
    'demo-2',
    'demo-1'
  ])
  expect((await restarted.tasks.list())[0]).toMatchObject({
    notes: 'kept on restart',
    scheduledFor: null
  })
  await restarted.tasks.restore('demo-3')
  expect((await restarted.tasks.list()).some((item) => item.id === 'demo-3')).toBe(true)
})
it('demo focus resumes without paused time and records one capped round after sleep', async () => {
  const { bridge } = await setup()
  await bridge.settings.update({ pomodoroFocusMinutes: 1 })
  await bridge.focus.start({ mode: 'pomodoro', taskId: 'demo-1' })
  vi.setSystemTime(Date.now() + 20_000)
  await bridge.focus.pause()
  vi.setSystemTime(Date.now() + 300_000)
  await bridge.focus.resume()
  const state = await bridge.focus.getState()
  expect(state.accumulatedSeconds).toBe(20)
  vi.setSystemTime(Date.now() + 7200_000)
  await bridge.focus.getState()
  await bridge.focus.getState()
  const sessions = (await bridge.focus.getStats()).sessions
  expect(sessions).toHaveLength(1)
  expect(sessions[0].durationSeconds).toBe(60)
})
