import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { AlertTriangle, Plus, RotateCcw, TimerReset } from 'lucide-react'
import { AnimatePresence, motion, MotionConfig } from 'motion/react'
import { lazy, Suspense, useEffect, useMemo, useRef } from 'react'
import { api, isTauri } from './bridge'
import { DetailDrawer } from './components/DetailDrawer'
import { FocusDock, MiniFocus } from './components/FocusDock'
import { MobileNav } from './components/MobileNav'
import { QuickAdd } from './components/QuickAdd'
import { Sidebar } from './components/Sidebar'
import { TaskList } from './components/TaskList'
import { TitleBar } from './components/TitleBar'
import { ToastProvider } from './components/Toast'
import { FocusFeedback } from './features/focus/FocusFeedback'
import { beginAdd } from './features/tasks/navigation'
import { useNudgeStore } from './store'
import { filterTasks, formatFriendlyDate } from './utils'

const CommandPalette = lazy(() =>
  import('./components/CommandPalette').then((module) => ({ default: module.CommandPalette }))
)
const SettingsDrawer = lazy(() =>
  import('./components/SettingsDrawer').then((module) => ({ default: module.SettingsDrawer }))
)
const FocusHistoryDrawer = lazy(() =>
  import('./components/FocusHistoryDrawer').then((module) => ({
    default: module.FocusHistoryDrawer
  }))
)
const LearningPackWorkspace = lazy(() =>
  import('./components/LearningPackWorkspace').then((module) => ({
    default: module.LearningPackWorkspace
  }))
)

function DrawerSkeleton(): React.JSX.Element {
  return (
    <aside className="detail-drawer drawer-skeleton" aria-label="正在打开面板" aria-busy="true">
      <div className="drawer-header">
        <span className="skeleton-line skeleton-short" />
      </div>
      <div className="drawer-scroll">
        <span className="skeleton-line" />
        <span className="skeleton-line" />
        <span className="skeleton-line skeleton-short" />
      </div>
    </aside>
  )
}

function LoadingScreen(): React.JSX.Element {
  return (
    <main className="loading-screen" aria-label="正在打开 Nudge">
      <span className="brand-mark loading-mark">
        <TimerReset size={18} />
      </span>
      <strong>Nudge</strong>
      <div className="loading-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </main>
  )
}

function ErrorScreen({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <main className="loading-screen error-screen" aria-label="Nudge 打开失败">
      <span className="error-mark">
        <AlertTriangle size={20} aria-hidden="true" />
      </span>
      <strong>本地数据暂时没有打开</strong>
      <p>{message}</p>
      <button type="button" className="primary-button" onClick={onRetry}>
        <RotateCcw size={15} aria-hidden="true" />
        重新尝试
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
  const today = useNudgeStore((state) => state.today)
  const backgroundError = useNudgeStore((state) => state.backgroundError)
  const refreshData = useNudgeStore((state) => state.refreshData)
  const drawerMode = useNudgeStore((state) => state.drawerMode)
  const setCommandOpen = useNudgeStore((state) => state.setCommandOpen)
  const openLearningTaskId = useNudgeStore((state) => state.openLearningTaskId)
  const listRegion = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(0)

  useEffect(() => {
    void initialize()
    return () => useNudgeStore.getState().dispose()
  }, [initialize])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && ['f', 'k'].includes(event.key.toLowerCase())) {
        event.preventDefault()
        setCommandOpen(!useNudgeStore.getState().commandOpen)
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        beginAdd()
      }
    }
    const offQuickAdd = api.desktop.onQuickAdd(beginAdd)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      offQuickAdd()
    }
  }, [setCommandOpen])

  useEffect(() => {
    if (!openLearningTaskId && listRegion.current) listRegion.current.scrollTop = scrollTop.current
  }, [openLearningTaskId])
  useEffect(() => {
    scrollTop.current = 0
    if (listRegion.current) listRegion.current.scrollTop = 0
  }, [currentView])

  const viewTitle = useMemo(() => {
    if (currentView === 'today') return '今天'
    if (currentView === 'inbox') return '收集箱'
    if (currentView === 'upcoming') return '计划'
    if (currentView === 'completed') return '已完成'
    return lists.find((list) => list.id === currentView.slice(5))?.name ?? '清单'
  }, [currentView, lists])

  const visibleTasks = useMemo(
    () => filterTasks(tasks, currentView, '', today),
    [currentView, today, tasks]
  )
  const visibleCount = visibleTasks.length

  if (!initialized) {
    return error ? (
      <ErrorScreen message={error} onRetry={() => void initialize()} />
    ) : (
      <LoadingScreen />
    )
  }

  return (
    <div className={`app-shell ${drawerMode ? 'has-drawer' : ''}`}>
      <TitleBar />
      <Sidebar />
      <main className="main-pane" id="main-content">
        {backgroundError && (
          <div className="inline-notice" role="alert">
            <span>{backgroundError}</span>
            <button type="button" onClick={() => void refreshData()}>
              重新刷新
            </button>
          </div>
        )}
        {!isTauri && (
          <div className="preview-label">
            浏览器预览 · 数据仅保留在当前标签页，桌面版在本地持久保存
          </div>
        )}
        <FocusFeedback />
        <div className="daily-view" hidden={Boolean(openLearningTaskId)}>
          <div className="main-toolbar">
            <div className="view-heading">
              <span>
                {currentView === 'today' ? formatFriendlyDate() : `${visibleCount} 个项目`}
              </span>
              <h1>{viewTitle}</h1>
            </div>
            <span className="view-count">
              {visibleCount} 项{currentView === 'completed' ? '已完成' : '待办'}
            </span>
          </div>
          {currentView === 'completed' ? (
            <button type="button" className="completed-add secondary-button" onClick={beginAdd}>
              <Plus size={15} />
              再记一件事
            </button>
          ) : (
            <QuickAdd />
          )}
          <div
            ref={listRegion}
            className="task-scroll-region"
            onScroll={() => {
              if (!openLearningTaskId) scrollTop.current = listRegion.current?.scrollTop ?? 0
            }}
          >
            <TaskList />
          </div>
        </div>
        {openLearningTaskId && (
          <div className="learning-page">
            <Suspense
              fallback={
                <div className="learning-loading" role="status">
                  正在打开学习工作区…
                </div>
              }
            >
              <LearningPackWorkspace key={openLearningTaskId} taskId={openLearningTaskId} />
            </Suspense>
          </div>
        )}
        <FocusDock />
      </main>

      <AnimatePresence mode="wait">
        {drawerMode ? (
          <motion.div
            className="drawer-slot"
            key={drawerMode}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 18 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
          >
            <Suspense fallback={<DrawerSkeleton />}>
              {drawerMode === 'task' ? (
                <DetailDrawer />
              ) : drawerMode === 'settings' ? (
                <SettingsDrawer />
              ) : (
                <FocusHistoryDrawer />
              )}
            </Suspense>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
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
    return () => useNudgeStore.getState().dispose()
  }, [initializeMini])
  if (initialized)
    return (
      <>
        <FocusFeedback />
        <MiniFocus />
      </>
    )
  return error ? (
    <ErrorScreen message={error} onRetry={() => void initializeMini()} />
  ) : (
    <LoadingScreen />
  )
}

export default function App(): React.JSX.Element {
  const mini =
    new URLSearchParams(window.location.search).get('mini') === '1' ||
    (Boolean(window.__TAURI_INTERNALS__) && getCurrentWebviewWindow().label === 'focus')
  return (
    <MotionConfig reducedMotion="user">
      <ToastProvider>{mini ? <MiniApp /> : <MainApp />}</ToastProvider>
    </MotionConfig>
  )
}
