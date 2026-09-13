import type { LearningPack, LearningSection } from '@shared/types'
import {
  ArrowLeft,
  BookOpen,
  CircleDashed,
  LoaderCircle,
  LockKeyhole,
  Route,
  Sparkles,
  Video,
  X
} from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { api } from '../../bridge'
import { useToast } from '../../components/Toast'
import { useNudgeStore } from '../../store'
import { findTask } from '../tasks/model'
import { SECTION_COPY, progressPercent } from './model'
import { ResourceColumn } from './ResourceColumn'
import { RoadmapColumn } from './RoadmapColumn'

type LearningTab = LearningSection

function LearningStatus({ pack }: { pack: LearningPack }): React.JSX.Element {
  const progress = progressPercent(pack)
  const label =
    pack.status === 'generating'
      ? '正在规划'
      : pack.status === 'partial'
        ? '部分完成'
        : pack.status === 'error'
          ? '需要重试'
          : pack.status === 'ready'
            ? `路线 ${progress}%`
            : '等待规划'
  return (
    <span className={`learning-pack-status status-${pack.status}`}>
      {pack.status === 'generating' ? (
        <LoaderCircle size={13} className="spin" aria-hidden="true" />
      ) : (
        <CircleDashed size={13} aria-hidden="true" />
      )}
      {label}
    </span>
  )
}

export function LearningPackWorkspace({ taskId }: { taskId: string }): React.JSX.Element {
  const task = useNudgeStore((state) => findTask(state.tasks, taskId))
  const pack = useNudgeStore((state) => state.learningPacks[taskId])
  const error = useNudgeStore((state) => state.learningErrors[taskId])
  const recommendationSettings = useNudgeStore((state) => state.recommendationSettings)
  const openLearning = useNudgeStore((state) => state.openLearning)
  const closeLearning = useNudgeStore((state) => state.closeLearning)
  const refreshLearning = useNudgeStore((state) => state.refreshLearning)
  const generateLearning = useNudgeStore((state) => state.generateLearning)
  const [activeTab, setActiveTab] = useState<LearningTab>('resources')
  const [consentSections, setConsentSections] = useState<LearningSection[] | null>(null)
  const [consentAcknowledged, setConsentAcknowledged] = useState(false)
  const [generating, setGenerating] = useState(false)
  const showToast = useToast()

  useEffect(() => {
    if (!pack && !error) void openLearning(taskId).catch(() => undefined)
  }, [openLearning, pack, error, taskId])
  useEffect(
    () => setConsentAcknowledged(false),
    [
      recommendationSettings?.provider,
      recommendationSettings?.endpoint,
      recommendationSettings?.sendNotes
    ]
  )

  if (!task)
    return (
      <section className="learning-pack">
        <button type="button" className="learning-back" onClick={closeLearning}>
          <ArrowLeft size={16} />
          返回任务列表
        </button>
        <p className="learning-loading">此任务已经移除。</p>
      </section>
    )
  if (!pack) {
    return (
      <section
        className="learning-pack learning-pack-loading"
        aria-label={`“${task.title}”学习工作区`}
      >
        <button type="button" className="learning-back" onClick={closeLearning}>
          <ArrowLeft size={16} />
          返回任务列表
        </button>
        {error ? (
          <div className="learning-load-error" role="alert">
            <h2>任务已保存，学习包暂时无法打开</h2>
            <p>{error}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => void openLearning(taskId).catch(() => undefined)}
            >
              重试打开
            </button>
          </div>
        ) : (
          <div className="learning-pack-skeleton" role="status" aria-label="正在打开学习包">
            <span />
            <span />
            <span />
          </div>
        )}
      </section>
    )
  }

  const runGeneration = async (sections: LearningSection[]): Promise<void> => {
    setGenerating(true)
    try {
      await generateLearning(taskId, sections)
      showToast({
        message:
          recommendationSettings?.provider === 'offline'
            ? '离线学习模板已经准备好'
            : '学习包已经更新'
      })
    } catch (error) {
      showToast({
        message: '学习包没有全部生成',
        detail: error instanceof Error ? error.message : '可以单栏重试'
      })
    } finally {
      setGenerating(false)
    }
  }

  const requestGeneration = (sections: LearningSection[]): void => {
    if (generating || pack.status === 'generating') return
    if (
      recommendationSettings &&
      recommendationSettings.provider !== 'offline' &&
      !consentAcknowledged
    ) {
      setConsentSections(sections)
      return
    }
    void runGeneration(sections)
  }

  const progress = progressPercent(pack)
  return (
    <motion.section
      className="learning-pack"
      aria-label={`“${task.title}”学习工作区`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <button type="button" className="learning-back" onClick={closeLearning}>
        <ArrowLeft size={16} />
        返回任务列表
      </button>
      <header className="learning-pack-header">
        <div className="learning-pack-title">
          <span className="learning-pack-mark">
            <Sparkles size={16} />
          </span>
          <div>
            <h2>{task.title}</h2>
          </div>
        </div>
        <div className="learning-pack-header-actions">
          <span className="learning-overall-progress" title={`路线完成 ${progress}%`}>
            <span style={{ '--learning-progress': progress / 100 } as React.CSSProperties}>
              <i />
            </span>
            {progress}%
          </span>
          <LearningStatus pack={pack} />
          {generating || pack.status === 'generating' ? (
            <button
              type="button"
              className="learning-cancel-button"
              onClick={() => {
                void api.learning
                  .cancel(taskId)
                  .then(() => {
                    showToast({ message: '正在取消生成', detail: '已经完成的分栏会保留下来。' })
                  })
                  .catch((error) =>
                    showToast({ tone: 'error', message: '取消失败', detail: String(error) })
                  )
              }}
            >
              <X size={14} />
              取消生成
            </button>
          ) : (
            <button
              type="button"
              className="learning-generate-button"
              onClick={() => requestGeneration(['resources', 'videos', 'roadmap'])}
            >
              <Sparkles size={14} />
              {pack.provider === 'offline' ? '生成推荐' : '重新规划'}
            </button>
          )}
        </div>
      </header>

      {consentSections ? (
        <div className="learning-consent" role="dialog" aria-label="联网生成确认">
          <span className="consent-icon">
            <LockKeyhole size={17} />
          </span>
          <div>
            <strong>确认发送这些学习信息</strong>
            <p>
              将发送任务标题、标签{recommendationSettings?.sendNotes ? '，以及你已授权的备注' : ''}
              到“{recommendationSettings?.endpoint}”。不会发送其他任务、数据库或同步凭据。
            </p>
          </div>
          <button type="button" className="text-button" onClick={() => setConsentSections(null)}>
            取消
          </button>
          <button
            type="button"
            className="compact-primary"
            onClick={() => {
              const sections = consentSections
              setConsentAcknowledged(true)
              setConsentSections(null)
              void runGeneration(sections)
            }}
          >
            确认并生成
          </button>
        </div>
      ) : null}

      <div className="learning-mobile-tabs" role="tablist" aria-label="学习包分栏">
        {(['resources', 'videos', 'roadmap'] as LearningTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`learning-tab-${tab}`}
            aria-controls={`learning-panel-${tab}`}
            tabIndex={activeTab === tab ? 0 : -1}
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            onKeyDown={(event) => {
              const tabs: LearningTab[] = ['resources', 'videos', 'roadmap']
              const index = tabs.indexOf(tab)
              const next =
                event.key === 'ArrowRight'
                  ? tabs[(index + 1) % 3]
                  : event.key === 'ArrowLeft'
                    ? tabs[(index + 2) % 3]
                    : event.key === 'Home'
                      ? tabs[0]
                      : event.key === 'End'
                        ? tabs[2]
                        : null
              if (next) {
                event.preventDefault()
                setActiveTab(next)
                document.getElementById(`learning-tab-${next}`)?.focus()
              }
            }}
          >
            {tab === 'resources' ? (
              <BookOpen size={15} />
            ) : tab === 'videos' ? (
              <Video size={15} />
            ) : (
              <Route size={15} />
            )}
            {SECTION_COPY[tab].title}
          </button>
        ))}
      </div>

      <div className="learning-columns">
        <div
          id="learning-panel-resources"
          role="tabpanel"
          aria-labelledby="learning-tab-resources"
          className={activeTab === 'resources' ? 'is-mobile-active' : ''}
        >
          <ResourceColumn
            pack={pack}
            section="resources"
            kinds={['document', 'tool']}
            onChanged={() => refreshLearning(taskId).then(() => undefined)}
            onRetry={() => requestGeneration(['resources'])}
          />
        </div>
        <div
          id="learning-panel-videos"
          role="tabpanel"
          aria-labelledby="learning-tab-videos"
          className={activeTab === 'videos' ? 'is-mobile-active' : ''}
        >
          <ResourceColumn
            pack={pack}
            section="videos"
            kinds={['video']}
            onChanged={() => refreshLearning(taskId).then(() => undefined)}
            onRetry={() => requestGeneration(['videos'])}
          />
        </div>
        <div
          id="learning-panel-roadmap"
          role="tabpanel"
          aria-labelledby="learning-tab-roadmap"
          className={activeTab === 'roadmap' ? 'is-mobile-active' : ''}
        >
          <RoadmapColumn
            pack={pack}
            isActive={activeTab === 'roadmap'}
            onChanged={() => refreshLearning(taskId).then(() => undefined)}
            onRetry={() => requestGeneration(['roadmap'])}
          />
        </div>
      </div>
    </motion.section>
  )
}
