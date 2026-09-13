import type { Task } from '@shared/types'
import { useToast } from '../../components/Toast'
import { useNudgeStore } from '../../store'

export function useTaskActions() {
  const showToast = useToast()
  const completeTask = useNudgeStore((state) => state.completeTask)
  const deleteTask = useNudgeStore((state) => state.deleteTask)
  const restoreTask = useNudgeStore((state) => state.restoreTask)
  const updateTask = useNudgeStore((state) => state.updateTask)
  const attempt = async (action: () => Promise<void>, message: string): Promise<boolean> => {
    try {
      await action()
      return true
    } catch (error) {
      showToast({
        message,
        detail: error instanceof Error ? error.message : '请重试',
        tone: 'error'
      })
      return false
    }
  }
  return {
    complete: (task: Task) =>
      attempt(async () => {
        const completed = task.status !== 'completed'
        await completeTask(task.id, completed)
        showToast({
          message: completed ? '又完成了一件事' : '任务已重新打开',
          detail: task.title,
          actionLabel: '撤销',
          onAction: async () => {
            await completeTask(task.id, !completed)
          }
        })
      }, '任务状态没有保存'),
    remove: (task: Task) =>
      attempt(async () => {
        await deleteTask(task.id)
        showToast({
          message: '任务已移除',
          detail: task.title,
          actionLabel: '撤销',
          onAction: async () => {
            await restoreTask(task.id)
          }
        })
      }, '任务没有删除'),
    schedule: (task: Task, scheduledFor: string | null) =>
      attempt(async () => {
        await updateTask(task.id, { scheduledFor })
        showToast({
          message: scheduledFor ? `已安排到 ${scheduledFor}` : '已取消日期安排',
          detail: task.title,
          actionLabel: '撤销',
          onAction: async () => {
            await updateTask(task.id, { scheduledFor: task.scheduledFor })
          }
        })
      }, '日期没有保存')
  }
}
