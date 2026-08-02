import { useEffect, useState } from 'react'
import { Command, Minus, Search, Sparkles, Square, X } from 'lucide-react'
import { api } from '../bridge'
import { useNudgeStore } from '../store'

export function TitleBar(): React.JSX.Element {
  const setCommandOpen = useNudgeStore((state) => state.setCommandOpen)
  const [platform, setPlatform] = useState('unknown')

  useEffect(() => {
    void api.desktop.platform().then(setPlatform)
  }, [])

  return (
    <header className={`title-bar platform-${platform}`} data-tauri-drag-region>
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
      <div className="window-controls no-drag" aria-label="窗口控制">
        <button type="button" aria-label="最小化" onClick={() => void api.desktop.minimize()}><Minus size={15} /></button>
        <button type="button" aria-label="最大化或还原" onClick={() => void api.desktop.toggleMaximize()}><Square size={12} /></button>
        <button type="button" className="window-close" aria-label="关闭" onClick={() => void api.desktop.close()}><X size={15} /></button>
      </div>
    </header>
  )
}
