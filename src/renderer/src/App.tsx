import { useEffect, useMemo } from 'react'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, RotateCcw, Search, TimerReset, X } from 'lucide-react'
import { CommandPalette } from './components/CommandPalette'
import { DetailDrawer } from './components/DetailDrawer'
import { FocusDock, MiniFocus } from './components/FocusDock'
import { QuickAdd } from './components/QuickAdd'
import { SettingsDrawer } from './components/SettingsDrawer'
import { Sidebar } from './components/Sidebar'
import { TaskList } from './components/TaskList'
import { LearningPackWorkspace } from './components/LearningPackWorkspace'
import { MobileNav } from './components/MobileNav'
import { TitleBar } from './components/TitleBar'
import { ToastProvider } from './components/Toast'
import { useNudgeStore } from './store'
import { filterTasks, formatFriendlyDate } from './utils'

function LoadingScreen(): React.JSX.Element {
  return (
    <main className="loading-screen" aria-label="正在打开 Nudge">
      <span className="brand-mark loading-mark"><TimerReset size={18} /></span>
      <strong>Nudge</strong>
      <div className="loading-lines" aria-hidden="true"><span /><span /><span /></div>
    </main>
  )
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <main className="loading-screen error-screen" aria-label="Nudge 打开失败">
      <span className="error-mark"><AlertTriangle size={20} aria-hidden="true" /></span>
      <strong>本地数据暂时没有打开</strong>
      <p>{message}</p>
      <button type="button" className="primary-button" onClick={onRetry}>
        <RotateCcw size={15} aria-hidden="true" />重新尝试
      </button>
    </main>
  )
}

function MainApp(): React.JSX.Element {
  const initialize = useNudgeStore((state) => state.initialize)
  const initialized = useNudgeStore((state) => state.initialized)
  const error = useNudgeStore((state) => state.error)
  const tasks = useNudgeStore((state) => state.tasks)
  const lists = useNudgeStore((state) => state.lists)
  const currentView = useNudgeStore((state) => state.currentView)
  const search = useNudgeStore((state) => state.search)
  const setSearch = useNudgeStore((state) => state.setSearch)
  const drawerMode = useNudgeStore((state) => state.drawerMode)
  const setCommandOpen = useNudgeStore((state) => state.setCommandOpen)
  const openLearningTaskId = useNudgeStore((state) => state.openLearningTaskId)

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        document.getElementById('task-search')?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const viewTitle = useMemo(() => {
    if (currentView === 'today') return '今天'
    if (currentView === 'inbox') return '收集箱'
    if (currentView === 'upcoming') return '计划'
    if (currentView === 'completed') return '已完成'
    return lists.find((list) => list.id === currentView.slice(5))?.name ?? '清单'
  }, [currentView, lists])

  const visibleTasks = useMemo(() => filterTasks(tasks, currentView, search), [currentView, search, tasks])
  const visibleCount = visibleTasks.length
  const learningNeedsQuickAnchor = Boolean(
    openLearningTaskId && !visibleTasks.some((task) => task.id === openLearningTaskId)
  )

  if (!initialized) {
    return error ? <ErrorScreen message={error} onRetry={() => void initialize()} /> : <LoadingScreen />
  }

  return (
    <div className={`app-shell ${drawerMode ? 'has-drawer' : ''}`}>
      <TitleBar />
      <Sidebar />
      <main className="main-pane" id="main-content">
        <div className="main-toolbar">
          <div className="view-heading">
            <span>{currentView === 'today' ? formatFriendlyDate() : `${visibleCount} 个项目`}</span>
            <h1>{viewTitle}</h1>
          </div>
          <div className="main-toolbar-actions">
            <label className={`task-search ${search ? 'has-value' : ''}`} htmlFor="task-search">
              <Search size={15} aria-hidden="true" />
              <input
                id="task-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索当前视图"
              />
              {search ? (
                <button type="button" className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}>
                  <X size={13} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <button type="button" className="toolbar-command" onClick={() => setCommandOpen(true)}>
              快捷命令 <kbd>Ctrl K</kbd>
            </button>
          </div>
        </div>
        <QuickAdd />
        {learningNeedsQuickAnchor && openLearningTaskId ? (
          <div className="quick-learning-anchor">
            <LearningPackWorkspace taskId={openLearningTaskId} />
          </div>
        ) : null}
        <div className="task-scroll-region">
          <TaskList />
        </div>
        <FocusDock />
      </main>

      <AnimatePresence mode="wait">
        {drawerMode ? (
          <motion.div
            className="drawer-slot"
            key={drawerMode}
            initial={{ opacity: 0, x: 24, filter: 'blur(2px)' }}
            animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, x: 18 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            {drawerMode === 'task' ? <DetailDrawer /> : <SettingsDrawer />}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <CommandPalette />
      <MobileNav />
    </div>
  )
}

function MiniApp(): React.JSX.Element {
  const initializeMini = useNudgeStore((state) => state.initializeMini)
  const initialized = useNudgeStore((state) => state.initialized)
  const error = useNudgeStore((state) => state.error)
  useEffect(() => {
    void initializeMini()
  }, [initializeMini])
  if (initialized) return <MiniFocus />
  return error ? <ErrorScreen message={error} onRetry={() => void initializeMini()} /> : <LoadingScreen />
}

export default function App(): React.JSX.Element {
  const mini = new URLSearchParams(window.location.search).get('mini') === '1'
    || (Boolean(window.__TAURI_INTERNALS__) && getCurrentWebviewWindow().label === 'focus')
  return <ToastProvider>{mini ? <MiniApp /> : <MainApp />}</ToastProvider>
}
