import type { Task } from '@shared/types'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useToast } from '../../components/Toast'
import { useNudgeStore } from '../../store'
import { createTaskDraft } from './draft'

const drafts = new Map<string, ReturnType<typeof createTaskDraft>>()

export function useTaskDraft(task: Task) {
  const showToast = useToast()
  const [draft] = useState(() => {
    const existing = drafts.get(task.id)
    if (existing) return existing
    const created = createTaskDraft(task, (input) =>
      useNudgeStore.getState().updateTask(task.id, input)
    )
    drafts.set(task.id, created)
    return created
  })
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot)
  useEffect(() => draft.receive(task), [draft, task])
  useEffect(() => {
    if (snapshot.status !== 'pending') return
    const timer = setTimeout(() => void draft.flush(), 600)
    return () => clearTimeout(timer)
  }, [draft, snapshot])
  useEffect(
    () => () => {
      void draft.flush().then((ok) => {
        if (!ok)
          showToast({
            tone: 'error',
            message: `“${task.title}”的更改尚未保存`,
            detail: '草稿已保留，可以打开任务重试。',
            actionLabel: '打开任务',
            onAction: () => useNudgeStore.getState().selectTask(task.id)
          })
      })
    },
    [draft, task.id, showToast]
  )
  return { ...snapshot, edit: draft.edit, flush: draft.flush }
}
