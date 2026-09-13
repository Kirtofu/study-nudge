import type { Task } from '@shared/types'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred, task } from '../features/tasks/test-fixtures'
import { useNudgeStore } from '../store'
import { QuickAdd } from './QuickAdd'
import { ToastProvider } from './Toast'

beforeEach(() =>
  useNudgeStore.setState({
    today: '2026-09-13',
    currentView: 'today',
    lists: [
      { id: 'inbox', name: '收集箱', color: '#c96442', position: 0, createdAt: '', updatedAt: '' }
    ]
  })
)
afterEach(cleanup)
const mount = () =>
  render(
    <ToastProvider>
      <QuickAdd />
    </ToastProvider>
  )

it('ignores IME Enter, prevents duplicate submits and leaves focus ready for the next entry', async () => {
  const result = deferred<Task>()
  const create = vi.fn(() => result.promise)
  useNudgeStore.setState({ createTask: create })
  const { container } = mount()
  const input = screen.getByLabelText('快速添加任务')
  const form = container.querySelector('form')!
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: '中文任务' } })
  fireEvent.compositionStart(input)
  fireEvent.submit(form)
  expect(create).not.toHaveBeenCalled()
  const key = new KeyboardEvent('keydown', {
    key: 'Enter',
    isComposing: true,
    cancelable: true,
    bubbles: true
  })
  input.dispatchEvent(key)
  expect(key.defaultPrevented).toBe(true)
  fireEvent.compositionEnd(input)
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(create).toHaveBeenCalledTimes(1)
  await act(async () => result.resolve(task('saved')))
  await waitFor(() => expect(input).toHaveValue(''))
  expect(input).toHaveFocus()
})
it('does not erase the next task typed while the first request is saving', async () => {
  const result = deferred<Task>()
  useNudgeStore.setState({ createTask: vi.fn(() => result.promise) })
  const { container } = mount()
  const input = screen.getByLabelText('快速添加任务')
  fireEvent.change(input, { target: { value: '第一件' } })
  fireEvent.submit(container.querySelector('form')!)
  fireEvent.change(input, { target: { value: '下一件' } })
  await act(async () => result.resolve(task('saved')))
  expect(input).toHaveValue('下一件')
})
it('retries opening a learning pack without creating a second saved task', async () => {
  const create = vi.fn(async () => task('saved'))
  const open = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({})
  useNudgeStore.setState({ createTask: create, openLearning: open })
  mount()
  const input = screen.getByLabelText('快速添加任务')
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: '学习 Rust' } })
  fireEvent.click(screen.getByRole('button', { name: '添加并规划学习' }))
  await screen.findByText('任务已保存，学习包暂时没有打开')
  expect(input).toHaveValue('')
  fireEvent.click(screen.getByRole('button', { name: '打开学习包' }))
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
  expect(create).toHaveBeenCalledOnce()
})
