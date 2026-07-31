import { Command, Search, Sparkles } from 'lucide-react'
import { useNudgeStore } from '../store'

export function TitleBar(): React.JSX.Element {
  const setCommandOpen = useNudgeStore((state) => state.setCommandOpen)

  return (
    <header className="title-bar">
      <div className="title-brand" aria-label="Nudge">
        <span className="brand-mark" aria-hidden="true">
          <Sparkles size={15} strokeWidth={2.2} />
        </span>
        <strong>Nudge</strong>
        <span className="title-subtitle">待办与专注</span>
      </div>
      <button type="button" className="command-trigger no-drag" onClick={() => setCommandOpen(true)}>
        <Search size={15} aria-hidden="true" />
        <span>搜索任务或运行命令</span>
        <kbd>
          <Command size={11} aria-hidden="true" />K
        </kbd>
      </button>
      <div className="title-drag-space" />
    </header>
  )
}
