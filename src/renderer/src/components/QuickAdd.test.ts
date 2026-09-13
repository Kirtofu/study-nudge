import { describe, expect, it } from 'vitest'
import { parseQuickTask } from '../features/tasks/quick-task'

describe('parseQuickTask', () => {
  it('extracts Chinese tags and priority without leaving control tokens in the title', () => {
    expect(parseQuickTask('完成交互验收 #测试 !高')).toEqual({
      title: '完成交互验收',
      priority: 'high',
      tagNames: ['测试']
    })
  })

  it('supports English priority aliases', () => {
    expect(parseQuickTask('Write release notes !medium #release')).toEqual({
      title: 'Write release notes',
      priority: 'medium',
      tagNames: ['release']
    })
  })
})
