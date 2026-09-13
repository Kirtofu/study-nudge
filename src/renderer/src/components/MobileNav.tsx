import type { ViewId } from '@shared/types'
import { CalendarDays, CheckCircle2, Inbox, Plus, Sun } from 'lucide-react'
import { beginAdd } from '../features/tasks/navigation'
import { useNudgeStore } from '../store'

const items: Array<{ id: ViewId; label: string; icon: typeof Inbox }> = [
  { id: 'inbox', label: '收集箱', icon: Inbox },
  { id: 'today', label: '今天', icon: Sun },
  { id: 'upcoming', label: '计划', icon: CalendarDays },
  { id: 'completed', label: '完成', icon: CheckCircle2 }
]

export function MobileNav(): React.JSX.Element {
  const currentView = useNudgeStore((state) => state.currentView)
  const setView = useNudgeStore((state) => state.setView)
  return (
    <nav className="mobile-nav" aria-label="移动端主导航">
      {items.slice(0, 2).map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            className={currentView === item.id ? 'is-active' : ''}
            onClick={() => setView(item.id)}
          >
            <Icon size={19} />
            <span>{item.label}</span>
          </button>
        )
      })}
      <button type="button" className="mobile-add-button" aria-label="添加任务" onClick={beginAdd}>
        <Plus size={22} />
      </button>
      {items.slice(2).map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            className={currentView === item.id ? 'is-active' : ''}
            onClick={() => setView(item.id)}
          >
            <Icon size={19} />
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
