import type { Priority } from '@shared/types'

export function parseQuickTask(raw: string): {
  title: string
  priority: Priority
  tagNames: string[]
} {
  const tagNames = [...new Set(Array.from(raw.matchAll(/#([^\s#]+)/g)).map((match) => match[1]))]
  let priority: Priority = 'none'
  if (/!高(?=\s|$)|!high\b/i.test(raw)) priority = 'high'
  else if (/!中(?=\s|$)|!medium\b/i.test(raw)) priority = 'medium'
  else if (/!低(?=\s|$)|!low\b/i.test(raw)) priority = 'low'
  const title = raw
    .replace(/#([^\s#]+)/g, '')
    .replace(/!(?:高|中|低)(?=\s|$)|!(?:high|medium|low)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { title, priority, tagNames }
}
