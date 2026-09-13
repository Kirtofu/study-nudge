import type { LearningPack, NudgeBridge } from '@shared/types'
import type { NudgeStore, StoreGet, StoreSet } from './types'

export function learningActions(
  set: StoreSet,
  get: StoreGet,
  api: NudgeBridge
): Pick<NudgeStore, 'openLearning' | 'closeLearning' | 'refreshLearning' | 'generateLearning'> {
  const pending = new Map<string, Promise<LearningPack>>()
  return {
    openLearning: async (taskId) => {
      set({ openLearningTaskId: taskId, drawerMode: null, selectedTaskId: null })
      if (get().learningPacks[taskId]) return get().learningPacks[taskId]
      if (!pending.has(taskId)) {
        set((state) => ({ learningErrors: { ...state.learningErrors, [taskId]: '' } }))
        pending.set(
          taskId,
          (async () => {
            try {
              const pack = (await api.learning.get(taskId)) ?? (await api.learning.ensure(taskId))
              set((state) => ({ learningPacks: { ...state.learningPacks, [taskId]: pack } }))
              return pack
            } catch (error) {
              set((state) => ({
                learningErrors: {
                  ...state.learningErrors,
                  [taskId]: error instanceof Error ? error.message : '学习包暂时无法打开'
                }
              }))
              throw error
            } finally {
              pending.delete(taskId)
            }
          })()
        )
      }
      return pending.get(taskId)!
    },
    closeLearning: () => set({ openLearningTaskId: null }),
    refreshLearning: async (taskId) => {
      const pack = await api.learning.get(taskId)
      set((state) => {
        const learningPacks = { ...state.learningPacks }
        if (pack) learningPacks[taskId] = pack
        else delete learningPacks[taskId]
        return { learningPacks }
      })
      return pack
    },
    generateLearning: async (taskId, sections) => {
      const pack = await api.learning.generate(taskId, { sections })
      set((state) => ({ learningPacks: { ...state.learningPacks, [taskId]: pack } }))
      return pack
    }
  }
}
