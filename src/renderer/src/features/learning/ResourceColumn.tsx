import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { LearningPack, LearningResource, LearningResourceKind } from '@shared/types'
import '@xyflow/react/dist/style.css'
import {
  ArrowUpRight,
  BookOpen,
  CircleDashed,
  FileText,
  GitBranch,
  GripVertical,
  LoaderCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Video,
  X
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { api } from '../../bridge'
import { useToast } from '../../components/Toast'
import { useNudgeStore } from '../../store'

import { useRetainedForm } from '../../state/use-retained-form'
import { SECTION_COPY } from './model'

function SortableResourceCard({
  resource,
  onChanged
}: {
  resource: LearningResource
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [draft, setDraft] = useRetainedForm({
    title: resource.title,
    summary: resource.summary,
    url: resource.url,
    platform: resource.platform
  })
  const showToast = useToast()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: resource.id
  })

  useEffect(() => {
    let disposed = false
    setThumbnail(null)
    if (!resource.verified || !resource.thumbnailUrl) return
    void api.media
      .thumbnailDataUrl(resource.thumbnailUrl)
      .then((dataUrl) => {
        if (!disposed && dataUrl) setThumbnail(dataUrl)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [resource.thumbnailUrl, resource.verified])

  const saveResource = async (): Promise<void> => {
    if (!draft.title.trim()) return
    setSaving(true)
    try {
      await api.learning.resources.update(resource.id, {
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        url: draft.url.trim(),
        platform: draft.platform.trim()
      })
      await onChanged()
      setEditing(false)
      showToast({ message: '学习资源已保存' })
    } catch (error) {
      showToast({
        message: '资源没有保存',
        detail: error instanceof Error ? error.message : '请检查内容'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <motion.article
      ref={setNodeRef}
      layout
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`learning-resource ${isDragging ? 'is-dragging' : ''} ${resource.pinned ? 'is-pinned' : ''}`}
    >
      <button
        type="button"
        className="resource-drag"
        aria-label={`拖动“${resource.title}”排序`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>
      {editing ? (
        <form
          className="resource-edit-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveResource()
          }}
        >
          <label>
            <span>标题</span>
            <input
              value={draft.title}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              maxLength={160}
              autoFocus
            />
          </label>
          <label>
            <span>摘要</span>
            <textarea
              value={draft.summary}
              onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              maxLength={600}
              rows={2}
            />
          </label>
          <label>
            <span>链接</span>
            <input
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              placeholder="https://"
              inputMode="url"
            />
          </label>
          <div className="resource-edit-actions">
            <button type="button" className="text-button" onClick={() => setEditing(false)}>
              取消
            </button>
            <button
              type="submit"
              className="compact-primary"
              disabled={saving || !draft.title.trim()}
            >
              <Save size={13} aria-hidden="true" />
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      ) : (
        <>
          {thumbnail ? (
            <img className="resource-thumbnail" src={thumbnail} alt="" loading="lazy" />
          ) : (
            <span className="resource-kind-icon" aria-hidden="true">
              {resource.kind === 'video' ? (
                <Video size={15} />
              ) : resource.kind === 'tool' ? (
                <GitBranch size={15} />
              ) : (
                <FileText size={15} />
              )}
            </span>
          )}
          <div className="resource-copy">
            <div className="resource-title-line">
              <h4>{resource.title}</h4>
              {resource.pinned ? <Pin size={12} aria-label="已固定" /> : null}
            </div>
            {resource.summary ? <p>{resource.summary}</p> : null}
            <span className="resource-source">
              {resource.platform || (resource.kind === 'video' ? '视频' : '资料')}
              {resource.verified
                ? ' · 已验证'
                : resource.source === 'local-template'
                  ? ' · 搜索入口'
                  : ''}
            </span>
          </div>
          <div className="resource-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={resource.pinned ? '取消固定' : '固定资源'}
              onClick={() =>
                void api.learning.resources.pin(resource.id, !resource.pinned).then(onChanged)
              }
            >
              {resource.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="编辑资源"
              onClick={() => setEditing(true)}
            >
              <Pencil size={14} />
            </button>
            {resource.url ? (
              <button
                type="button"
                className="icon-button resource-open"
                aria-label={`打开“${resource.title}”`}
                onClick={() => void api.desktop.openExternal(resource.url)}
              >
                <ArrowUpRight size={14} />
              </button>
            ) : null}
            <button
              type="button"
              className="icon-button danger-icon"
              aria-label={`删除“${resource.title}”`}
              onClick={() => {
                if (!window.confirm(`删除“${resource.title}”？`)) return
                void api.learning.resources.delete(resource.id).then(onChanged)
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </>
      )}
    </motion.article>
  )
}

export function ResourceColumn({
  pack,
  section,
  kinds,
  onChanged,
  onRetry
}: {
  pack: LearningPack
  section: 'resources' | 'videos'
  kinds: LearningResourceKind[]
  onChanged: () => Promise<void>
  onRetry: () => void
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({
    kind: kinds[0],
    title: '',
    summary: '',
    url: '',
    platform: ''
  })
  const progress = useNudgeStore((state) => state.learningProgress[pack.taskId]?.[section])
  const showToast = useToast()
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }))
  const resources = pack.resources.filter((resource) => kinds.includes(resource.kind))

  const onDragEnd = (event: DragEndEvent): void => {
    if (!event.over || event.active.id === event.over.id) return
    const from = resources.findIndex((item) => item.id === event.active.id)
    const to = resources.findIndex((item) => item.id === event.over?.id)
    if (from < 0 || to < 0) return
    const next = arrayMove(resources, from, to)
    void api.learning.resources
      .reorder(
        pack.id,
        next.map((item) => item.id)
      )
      .then(onChanged)
      .catch((error) =>
        showToast({ tone: 'error', message: '资源顺序没有保存', detail: String(error) })
      )
  }

  const addResource = async (): Promise<void> => {
    if (!draft.title.trim()) return
    setSaving(true)
    try {
      await api.learning.resources.create(pack.taskId, {
        kind: draft.kind,
        title: draft.title.trim(),
        summary: draft.summary.trim(),
        url: draft.url.trim(),
        platform: draft.platform.trim(),
        language: 'zh-CN'
      })
      await onChanged()
      setDraft({ kind: kinds[0], title: '', summary: '', url: '', platform: '' })
      setAdding(false)
      showToast({ message: '资源已经加入学习包' })
    } catch (error) {
      showToast({
        message: '资源没有添加',
        detail: error instanceof Error ? error.message : '请检查链接'
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className={`learning-column learning-column-${section}`}
      aria-labelledby={`learning-${section}-${pack.id}`}
    >
      <div className="learning-column-header">
        <div className="learning-column-heading">
          <span className="learning-column-icon" aria-hidden="true">
            {section === 'videos' ? <Video size={17} /> : <BookOpen size={17} />}
          </span>
          <div>
            <h3 id={`learning-${section}-${pack.id}`}>{SECTION_COPY[section].title}</h3>
            <p>{SECTION_COPY[section].description}</p>
          </div>
        </div>
        <div className="learning-column-tools">
          <span>{resources.length}</span>
          <button
            type="button"
            className="icon-button"
            aria-label={`重新生成${SECTION_COPY[section].title}`}
            onClick={onRetry}
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={`添加${SECTION_COPY[section].title}`}
            onClick={() => setAdding((value) => !value)}
          >
            {adding ? <X size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
      {progress && progress.state !== 'success' ? (
        <div className={`learning-progress progress-${progress.state}`} role="status">
          {progress.state === 'generating' ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <CircleDashed size={13} />
          )}
          <span>{progress.message}</span>
        </div>
      ) : null}
      <AnimatePresence initial={false}>
        {adding ? (
          <motion.form
            className="resource-add-form"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            onSubmit={(event) => {
              event.preventDefault()
              void addResource()
            }}
          >
            {kinds.length > 1 ? (
              <label>
                <span>类型</span>
                <select
                  value={draft.kind}
                  onChange={(event) =>
                    setDraft({ ...draft, kind: event.target.value as LearningResourceKind })
                  }
                >
                  <option value="document">文档资料</option>
                  <option value="tool">练习工具</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>标题</span>
              <input
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                autoFocus
                maxLength={160}
              />
            </label>
            <label>
              <span>摘要</span>
              <textarea
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                rows={2}
              />
            </label>
            <label>
              <span>HTTPS 链接</span>
              <input
                value={draft.url}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                placeholder="https://"
                inputMode="url"
              />
            </label>
            <button
              type="submit"
              className="compact-primary"
              disabled={!draft.title.trim() || saving}
            >
              <Plus size={13} />
              {saving ? '添加中…' : '加入这一栏'}
            </button>
          </motion.form>
        ) : null}
      </AnimatePresence>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={resources.map((resource) => resource.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="learning-resource-list">
            <AnimatePresence initial={false} mode="popLayout">
              {resources.map((resource) => (
                <SortableResourceCard key={resource.id} resource={resource} onChanged={onChanged} />
              ))}
            </AnimatePresence>
            {!resources.length ? (
              <button type="button" className="column-empty-action" onClick={() => setAdding(true)}>
                <Plus size={15} />
                添加第一条内容
              </button>
            ) : null}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  )
}
