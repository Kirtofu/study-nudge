import type { LearningNodeStatus, LearningPack, LearningSection } from '@shared/types'

export type UndoAction = { label: string; run: () => Promise<void> }

export const SECTION_COPY: Record<LearningSection, { title: string; description: string }> = {
  resources: { title: '资料与工具', description: '官方资料、参考内容与动手工具' },
  videos: { title: '精选视频', description: 'YouTube、B站与可验证的外链' },
  roadmap: { title: '学习路线', description: '可拖拽、连接与完成的工作流' }
}

export function nextNodeStatus(status: LearningNodeStatus): LearningNodeStatus {
  if (status === 'pending') return 'active'
  if (status === 'active') return 'completed'
  return 'pending'
}

export function progressPercent(pack: LearningPack): number {
  if (!pack.nodes.length) return 0
  return Math.round(
    (pack.nodes.filter((node) => node.status === 'completed').length / pack.nodes.length) * 100
  )
}
