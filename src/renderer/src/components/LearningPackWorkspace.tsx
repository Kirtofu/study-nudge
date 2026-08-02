import { useEffect, useMemo, useRef, useState } from 'react'
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
import dagre from '@dagrejs/dagre'
import { AnimatePresence, motion } from 'motion/react'
import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleDashed,
  FileText,
  GitBranch,
  GripVertical,
  LayoutDashboard,
  List,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Route,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Video,
  X
} from 'lucide-react'
import type {
  LearningEdge,
  LearningNode,
  LearningNodeStatus,
  LearningPack,
  LearningResource,
  LearningResourceKind,
  LearningSection,
  Task
} from '@shared/types'
import { api } from '../bridge'
import { useNudgeStore } from '../store'
import { useToast } from './Toast'

type LearningTab = 'resources' | 'videos' | 'roadmap'
type UndoAction = { label: string; run: () => Promise<void> }

const SECTION_COPY: Record<LearningSection, { title: string; description: string }> = {
  resources: { title: '资料与工具', description: '官方资料、参考内容与动手工具' },
  videos: { title: '精选视频', description: 'YouTube、B站与可验证的外链' },
  roadmap: { title: '学习路线', description: '可拖拽、连接与完成的工作流' }
}

function nextNodeStatus(status: LearningNodeStatus): LearningNodeStatus {
  if (status === 'pending') return 'active'
  if (status === 'active') return 'completed'
  return 'pending'
}

function progressPercent(pack: LearningPack): number {
  if (!pack.nodes.length) return 0
  return Math.round((pack.nodes.filter((node) => node.status === 'completed').length / pack.nodes.length) * 100)
}

function LearningStatus({ pack }: { pack: LearningPack }): React.JSX.Element {
  const progress = progressPercent(pack)
  const label =
    pack.status === 'generating' ? '正在规划' :
      pack.status === 'partial' ? '部分完成' :
        pack.status === 'error' ? '需要重试' :
          pack.status === 'ready' ? `路线 ${progress}%` : '等待规划'
  return (
    <span className={`learning-pack-status status-${pack.status}`}>
      {pack.status === 'generating' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}
      {label}
    </span>
  )
}

function SortableResourceCard({
  resource,
  onChanged
}: {
  resource: LearningResource
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState({
    title: resource.title,
    summary: resource.summary,
    url: resource.url,
    platform: resource.platform
  })
  const showToast = useToast()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: resource.id })

  useEffect(() => {
    setDraft({ title: resource.title, summary: resource.summary, url: resource.url, platform: resource.platform })
  }, [resource])

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
      showToast({ message: '资源没有保存', detail: error instanceof Error ? error.message : '请检查内容' })
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
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={160} autoFocus />
          </label>
          <label>
            <span>摘要</span>
            <textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} maxLength={600} rows={2} />
          </label>
          <label>
            <span>链接</span>
            <input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://" inputMode="url" />
          </label>
          <div className="resource-edit-actions">
            <button type="button" className="text-button" onClick={() => setEditing(false)}>取消</button>
            <button type="submit" className="compact-primary" disabled={saving || !draft.title.trim()}>
              <Save size={13} aria-hidden="true" />{saving ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      ) : (
        <>
          {resource.thumbnailUrl ? (
            <img className="resource-thumbnail" src={resource.thumbnailUrl} alt="" loading="lazy" />
          ) : (
            <span className="resource-kind-icon" aria-hidden="true">
              {resource.kind === 'video' ? <Video size={15} /> : resource.kind === 'tool' ? <GitBranch size={15} /> : <FileText size={15} />}
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
              {resource.verified ? ' · 已验证' : resource.source === 'local-template' ? ' · 搜索入口' : ''}
            </span>
          </div>
          <div className="resource-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={resource.pinned ? '取消固定' : '固定资源'}
              onClick={() => void api.learning.resources.pin(resource.id, !resource.pinned).then(onChanged)}
            >
              {resource.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button type="button" className="icon-button" aria-label="编辑资源" onClick={() => setEditing(true)}>
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

function ResourceColumn({
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
  const [draft, setDraft] = useState({ kind: kinds[0], title: '', summary: '', url: '', platform: '' })
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
    void api.learning.resources.reorder(pack.id, next.map((item) => item.id)).then(onChanged)
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
      showToast({ message: '资源没有添加', detail: error instanceof Error ? error.message : '请检查链接' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={`learning-column learning-column-${section}`} aria-labelledby={`learning-${section}-${pack.id}`}>
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
          <button type="button" className="icon-button" aria-label={`重新生成${SECTION_COPY[section].title}`} onClick={onRetry}>
            <RefreshCw size={14} />
          </button>
          <button type="button" className="icon-button" aria-label={`添加${SECTION_COPY[section].title}`} onClick={() => setAdding((value) => !value)}>
            {adding ? <X size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
      {progress && progress.state !== 'success' ? (
        <div className={`learning-progress progress-${progress.state}`} role="status">
          {progress.state === 'generating' ? <LoaderCircle size={13} className="spin" /> : <CircleDashed size={13} />}
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
                <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as LearningResourceKind })}>
                  <option value="document">文档资料</option>
                  <option value="tool">练习工具</option>
                </select>
              </label>
            ) : null}
            <label><span>标题</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} autoFocus maxLength={160} /></label>
            <label><span>摘要</span><textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} rows={2} /></label>
            <label><span>HTTPS 链接</span><input value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://" inputMode="url" /></label>
            <button type="submit" className="compact-primary" disabled={!draft.title.trim() || saving}>
              <Plus size={13} />{saving ? '添加中…' : '加入这一栏'}
            </button>
          </motion.form>
        ) : null}
      </AnimatePresence>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={resources.map((resource) => resource.id)} strategy={verticalListSortingStrategy}>
          <div className="learning-resource-list">
            <AnimatePresence initial={false} mode="popLayout">
              {resources.map((resource) => (
                <SortableResourceCard key={resource.id} resource={resource} onChanged={onChanged} />
              ))}
            </AnimatePresence>
            {!resources.length ? (
              <button type="button" className="column-empty-action" onClick={() => setAdding(true)}>
                <Plus size={15} />添加第一条内容
              </button>
            ) : null}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  )
}

type RoadmapNodeData = {
  learningNode: LearningNode
  onSelect: (node: LearningNode) => void
  onToggleStatus: (node: LearningNode) => void
}
type RoadmapFlowNode = Node<RoadmapNodeData, 'roadmap'>

function RoadmapNodeCard({ data, selected }: NodeProps<RoadmapFlowNode>): React.JSX.Element {
  const node = data.learningNode
  return (
    <div className={`roadmap-node-card node-${node.status} ${selected ? 'is-selected' : ''}`} onDoubleClick={() => data.onSelect(node)}>
      <Handle type="target" position={Position.Top} />
      <button
        type="button"
        className="roadmap-status-toggle nodrag"
        aria-label={`切换“${node.title}”状态，当前为 ${node.status}`}
        onClick={() => data.onToggleStatus(node)}
      >
        {node.status === 'completed' ? <Check size={13} /> : <span />}
      </button>
      <div>
        <strong>{node.title}</strong>
        <span>{node.estimatedMinutes ? `${node.estimatedMinutes} 分钟` : node.kind}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const nodeTypes = { roadmap: RoadmapNodeCard }

function createsCycle(edges: Edge[], source: string, target: string): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
  adjacency.set(source, [...(adjacency.get(source) ?? []), target])
  const stack = [target]
  const visited = new Set<string>()
  while (stack.length) {
    const current = stack.pop()!
    if (current === source) return true
    if (visited.has(current)) continue
    visited.add(current)
    stack.push(...(adjacency.get(current) ?? []))
  }
  return false
}

function layoutWithDagre(nodes: LearningNode[], edges: LearningEdge[]): Array<LearningNode> {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: 'TB', ranksep: 64, nodesep: 36, marginx: 24, marginy: 24 })
  nodes.forEach((node) => graph.setNode(node.id, { width: 190, height: 72 }))
  edges.forEach((edge) => graph.setEdge(edge.sourceNodeId, edge.targetNodeId))
  dagre.layout(graph)
  return nodes.map((node) => {
    const position = graph.node(node.id) as { x: number; y: number } | undefined
    return position ? { ...node, x: position.x - 95, y: position.y - 36 } : node
  })
}

function NodeInspector({
  node,
  onSaved,
  onDelete
}: {
  node: LearningNode
  onSaved: () => Promise<void>
  onDelete: (node: LearningNode) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState({ title: node.title, description: node.description, estimatedMinutes: node.estimatedMinutes?.toString() ?? '' })
  const [saving, setSaving] = useState(false)
  const showToast = useToast()
  useEffect(() => setDraft({ title: node.title, description: node.description, estimatedMinutes: node.estimatedMinutes?.toString() ?? '' }), [node])
  return (
    <form
      className="node-inspector"
      onSubmit={(event) => {
        event.preventDefault()
        setSaving(true)
        void api.learning.roadmap.upsertNode(node.taskId, {
          ...node,
          title: draft.title.trim(),
          description: draft.description.trim(),
          estimatedMinutes: draft.estimatedMinutes ? Number(draft.estimatedMinutes) : null
        }).then(onSaved).then(() => showToast({ message: '路线节点已保存' })).catch((error) => {
          showToast({ message: '节点没有保存', detail: error instanceof Error ? error.message : '请检查内容' })
        }).finally(() => setSaving(false))
      }}
    >
      <label><span>节点名称</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} maxLength={120} /></label>
      <label><span>说明</span><textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={2} /></label>
      <label><span>预计分钟</span><input type="number" min="1" max="100000" value={draft.estimatedMinutes} onChange={(event) => setDraft({ ...draft, estimatedMinutes: event.target.value })} /></label>
      <div className="node-inspector-actions">
        <button type="button" className="text-button danger-text" onClick={() => onDelete(node)}><Trash2 size={13} />删除</button>
        <button type="submit" className="compact-primary" disabled={saving || !draft.title.trim()}><Save size={13} />{saving ? '保存中…' : '保存节点'}</button>
      </div>
    </form>
  )
}

function RoadmapColumn({
  pack,
  isActive,
  onChanged,
  onRetry
}: {
  pack: LearningPack
  isActive: boolean
  onChanged: () => Promise<void>
  onRetry: () => void
}): React.JSX.Element {
  const [view, setView] = useState<'graph' | 'list'>(pack.nodes.length >= 50 ? 'list' : 'graph')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [flowNodes, setFlowNodes] = useState<RoadmapFlowNode[]>([])
  const [flowEdges, setFlowEdges] = useState<Edge[]>([])
  const [undoVersion, setUndoVersion] = useState(0)
  const undoStack = useRef<UndoAction[]>([])
  const flowInstance = useRef<ReactFlowInstance<RoadmapFlowNode, Edge> | null>(null)
  const showToast = useToast()
  const progress = useNudgeStore((state) => state.learningProgress[pack.taskId]?.roadmap)

  const pushUndo = (action: UndoAction): void => {
    undoStack.current = [...undoStack.current.slice(-9), action]
    setUndoVersion((value) => value + 1)
  }

  const toggleNodeStatus = async (node: LearningNode): Promise<void> => {
    const previous = node.status
    const next = nextNodeStatus(previous)
    await api.learning.roadmap.setStatus(node.id, next)
    pushUndo({ label: `恢复“${node.title}”状态`, run: async () => { await api.learning.roadmap.setStatus(node.id, previous); await onChanged() } })
    await onChanged()
  }

  useEffect(() => {
    setFlowNodes(pack.nodes.map((node) => ({
      id: node.id,
      type: 'roadmap',
      position: { x: node.x, y: node.y },
      data: { learningNode: node, onSelect: (next) => setSelectedNodeId(next.id), onToggleStatus: (next) => void toggleNodeStatus(next) }
    })))
    setFlowEdges(pack.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      className: 'roadmap-edge'
    })))
  }, [pack])

  useEffect(() => {
    if (!isActive || view !== 'graph' || !flowNodes.length) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        void flowInstance.current?.fitView({ padding: 0.16, duration: reducedMotion ? 0 : 220 })
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [flowNodes.length, isActive, view])

  const selectedNode = pack.nodes.find((node) => node.id === selectedNodeId) ?? null

  const connect = async (connection: Connection): Promise<void> => {
    if (!connection.source || !connection.target) return
    if (createsCycle(flowEdges, connection.source, connection.target)) {
      showToast({ message: '不能形成循环依赖', detail: '请调整节点连接方向。' })
      return
    }
    try {
      const edge = await api.learning.roadmap.connect(pack.id, connection.source, connection.target)
      pushUndo({ label: '撤销节点连接', run: async () => { await api.learning.roadmap.disconnect(edge.id); await onChanged() } })
      await onChanged()
    } catch (error) {
      showToast({ message: '节点没有连接', detail: error instanceof Error ? error.message : '请换一个连接方向' })
    }
  }

  const autoLayout = async (): Promise<void> => {
    const previous = pack.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, title: node.title }))
    const layout = layoutWithDagre(pack.nodes, pack.edges)
    await Promise.all(layout.map((node) => api.learning.roadmap.upsertNode(pack.taskId, node)))
    pushUndo({
      label: '撤销自动布局',
      run: async () => {
        await Promise.all(previous.map((node) => {
          const current = pack.nodes.find((item) => item.id === node.id)!
          return api.learning.roadmap.upsertNode(pack.taskId, { ...current, x: node.x, y: node.y, title: current.title })
        }))
        await onChanged()
      }
    })
    await onChanged()
    showToast({ message: '路线图已经自动排版' })
  }

  const addNode = async (): Promise<void> => {
    if (!newTitle.trim()) return
    const node = await api.learning.roadmap.upsertNode(pack.taskId, {
      title: newTitle.trim(), kind: 'custom', description: '', status: 'pending',
      x: 40, y: 40 + pack.nodes.length * 96, position: (pack.nodes.length + 1) * 1000
    })
    pushUndo({ label: `删除“${node.title}”`, run: async () => { await api.learning.roadmap.deleteNode(node.id); await onChanged() } })
    setNewTitle('')
    setAdding(false)
    await onChanged()
    setSelectedNodeId(node.id)
  }

  const deleteNode = (node: LearningNode): void => {
    if (!window.confirm(`删除路线节点“${node.title}”？关联连线也会移除。`)) return
    const related = pack.edges.filter((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id)
    void api.learning.roadmap.deleteNode(node.id).then(async () => {
      pushUndo({
        label: `恢复“${node.title}”`,
        run: async () => {
          await api.learning.roadmap.upsertNode(pack.taskId, node)
          for (const edge of related) {
            await api.learning.roadmap.connect(pack.id, edge.sourceNodeId, edge.targetNodeId)
          }
          await onChanged()
        }
      })
      setSelectedNodeId(null)
      await onChanged()
    })
  }

  return (
    <section className="learning-column learning-column-roadmap" aria-labelledby={`learning-roadmap-${pack.id}`}>
      <div className="learning-column-header roadmap-header">
        <div className="learning-column-heading">
          <span className="learning-column-icon"><Route size={17} /></span>
          <div><h3 id={`learning-roadmap-${pack.id}`}>学习路线</h3><p>拖动节点，连接依赖，按步骤推进</p></div>
        </div>
        <div className="learning-column-tools">
          <button type="button" className="segmented-icon" aria-pressed={view === 'graph'} onClick={() => setView('graph')} title="图表视图"><LayoutDashboard size={14} /></button>
          <button type="button" className="segmented-icon" aria-pressed={view === 'list'} onClick={() => setView('list')} title="列表视图"><List size={14} /></button>
          <button type="button" className="icon-button" onClick={() => void autoLayout()} aria-label="自动布局"><GitBranch size={14} /></button>
          <button type="button" className="icon-button" disabled={!undoStack.current.length} onClick={() => {
            const action = undoStack.current.pop()
            setUndoVersion(undoVersion + 1)
            if (action) void action.run().then(() => showToast({ message: action.label }))
          }} aria-label="撤销路线操作"><Undo2 size={14} /></button>
          <button type="button" className="icon-button" onClick={onRetry} aria-label="重新生成学习路线"><RefreshCw size={14} /></button>
          <button type="button" className="icon-button" onClick={() => setAdding((value) => !value)} aria-label="添加路线节点">{adding ? <X size={14} /> : <Plus size={14} />}</button>
        </div>
      </div>
      {progress && progress.state !== 'success' ? (
        <div className={`learning-progress progress-${progress.state}`} role="status">
          {progress.state === 'generating' ? <LoaderCircle size={13} className="spin" /> : <CircleDashed size={13} />}
          <span>{progress.message}</span>
        </div>
      ) : null}
      {adding ? (
        <form className="roadmap-quick-add" onSubmit={(event) => { event.preventDefault(); void addNode() }}>
          <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="新增一个学习步骤…" autoFocus maxLength={120} />
          <button type="submit" className="compact-primary" disabled={!newTitle.trim()}><Plus size={13} />添加</button>
        </form>
      ) : null}
      <div className={`roadmap-workspace is-${view}`}>
        {view === 'graph' ? (
          <div className="roadmap-canvas" aria-label="可编辑学习路线图">
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.16 }}
              onInit={(instance) => { flowInstance.current = instance }}
              minZoom={0.35}
              maxZoom={1.8}
              snapToGrid
              snapGrid={[8, 8]}
              onNodesChange={(changes: NodeChange<RoadmapFlowNode>[]) => setFlowNodes((nodes) => applyNodeChanges(changes, nodes))}
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              onNodeDragStop={(_event, flowNode) => {
                const node = pack.nodes.find((item) => item.id === flowNode.id)
                if (!node) return
                const previous = { x: node.x, y: node.y }
                void api.learning.roadmap.upsertNode(pack.taskId, { ...node, x: flowNode.position.x, y: flowNode.position.y }).then(async () => {
                  pushUndo({ label: `恢复“${node.title}”位置`, run: async () => { await api.learning.roadmap.upsertNode(pack.taskId, { ...node, ...previous }); await onChanged() } })
                  await onChanged()
                })
              }}
              onConnect={(connection) => void connect(connection)}
              onEdgesDelete={(edges) => {
                edges.forEach((edge) => {
                  const existing = pack.edges.find((item) => item.id === edge.id)
                  void api.learning.roadmap.disconnect(edge.id).then(async () => {
                    if (existing) pushUndo({ label: '恢复节点连接', run: async () => { await api.learning.roadmap.connect(pack.id, existing.sourceNodeId, existing.targetNodeId); await onChanged() } })
                    await onChanged()
                  })
                })
              }}
              deleteKeyCode={['Backspace', 'Delete']}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} size={1} color="#d8d5ca" />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
          </div>
        ) : (
          <ol className="roadmap-list">
            {pack.nodes.map((node, index) => (
              <li key={node.id} className={`roadmap-list-item node-${node.status}`}>
                <button type="button" className="roadmap-list-check" onClick={() => void toggleNodeStatus(node)} aria-label={`切换“${node.title}”状态`}>
                  {node.status === 'completed' ? <Check size={13} /> : index + 1}
                </button>
                <button type="button" className="roadmap-list-copy" onClick={() => setSelectedNodeId(node.id)}>
                  <strong>{node.title}</strong><span>{node.description || '补充这个步骤的说明'}</span>
                </button>
                <small>{node.estimatedMinutes ? `${node.estimatedMinutes} 分钟` : '未估时'}</small>
              </li>
            ))}
          </ol>
        )}
        {selectedNode ? <NodeInspector key={selectedNode.id} node={selectedNode} onSaved={onChanged} onDelete={deleteNode} /> : null}
      </div>
    </section>
  )
}

export function LearningPackWorkspace({ taskId }: { taskId: string }): React.JSX.Element {
  const task = useNudgeStore((state) => state.tasks.flatMap((item) => [item, ...item.subtasks]).find((item) => item.id === taskId))
  const pack = useNudgeStore((state) => state.learningPacks[taskId])
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
    if (!pack) void openLearning(taskId)
  }, [openLearning, pack, taskId])

  if (!task) return <></>
  if (!pack) {
    return (
      <section className="learning-pack learning-pack-loading" aria-label={`正在打开“${task.title}”学习包`}>
        <div className="learning-pack-skeleton"><span /><span /><span /></div>
      </section>
    )
  }

  const runGeneration = async (sections: LearningSection[]): Promise<void> => {
    setGenerating(true)
    try {
      await generateLearning(taskId, sections)
      showToast({ message: recommendationSettings?.provider === 'offline' ? '离线学习模板已经准备好' : '学习包已经更新' })
    } catch (error) {
      showToast({ message: '学习包没有全部生成', detail: error instanceof Error ? error.message : '可以单栏重试' })
    } finally {
      setGenerating(false)
    }
  }

  const requestGeneration = (sections: LearningSection[]): void => {
    if (recommendationSettings && recommendationSettings.provider !== 'offline' && !consentAcknowledged) {
      setConsentSections(sections)
      return
    }
    void runGeneration(sections)
  }

  const progress = progressPercent(pack)
  return (
    <motion.section
      className="learning-pack"
      aria-label={`“${task.title}”学习包`}
      initial={{ opacity: 0, height: 0, y: -8 }}
      animate={{ opacity: 1, height: 'auto', y: 0 }}
      exit={{ opacity: 0, height: 0, y: -6 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <header className="learning-pack-header">
        <div className="learning-pack-title">
          <span className="learning-pack-mark"><Sparkles size={16} /></span>
          <div>
            <span>学习包</span>
            <h2>{task.title}</h2>
          </div>
        </div>
        <div className="learning-pack-header-actions">
          <span className="learning-overall-progress" title={`路线完成 ${progress}%`}>
            <span style={{ '--learning-progress': progress / 100 } as React.CSSProperties}><i /></span>
            {progress}%
          </span>
          <LearningStatus pack={pack} />
          {generating || pack.status === 'generating' ? (
            <button
              type="button"
              className="learning-cancel-button"
              onClick={() => {
                void api.learning.cancel(taskId).then(() => {
                  showToast({ message: '正在取消生成', detail: '已经完成的分栏会保留下来。' })
                })
              }}
            >
              <X size={14} />取消生成
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
          <button type="button" className="icon-button" aria-label="收起学习包" onClick={closeLearning}><ChevronDown size={16} /></button>
        </div>
      </header>

      {consentSections ? (
        <div className="learning-consent" role="dialog" aria-label="联网生成确认">
          <span className="consent-icon"><LockKeyhole size={17} /></span>
          <div>
            <strong>确认发送这些学习信息</strong>
            <p>将发送任务标题、标签{recommendationSettings?.sendNotes ? '，以及你已授权的备注' : ''}到“{recommendationSettings?.endpoint}”。不会发送其他任务、数据库或同步凭据。</p>
          </div>
          <button type="button" className="text-button" onClick={() => setConsentSections(null)}>取消</button>
          <button type="button" className="compact-primary" onClick={() => {
            const sections = consentSections
            setConsentAcknowledged(true)
            setConsentSections(null)
            void runGeneration(sections)
          }}>确认并生成</button>
        </div>
      ) : null}

      <div className="learning-mobile-tabs" role="tablist" aria-label="学习包分栏">
        {(['resources', 'videos', 'roadmap'] as LearningTab[]).map((tab) => (
          <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)}>
            {tab === 'resources' ? <BookOpen size={15} /> : tab === 'videos' ? <Video size={15} /> : <Route size={15} />}
            {SECTION_COPY[tab].title}
          </button>
        ))}
      </div>

      <div className="learning-columns">
        <div className={activeTab === 'resources' ? 'is-mobile-active' : ''}>
          <ResourceColumn pack={pack} section="resources" kinds={['document', 'tool']} onChanged={() => refreshLearning(taskId).then(() => undefined)} onRetry={() => requestGeneration(['resources'])} />
        </div>
        <div className={activeTab === 'videos' ? 'is-mobile-active' : ''}>
          <ResourceColumn pack={pack} section="videos" kinds={['video']} onChanged={() => refreshLearning(taskId).then(() => undefined)} onRetry={() => requestGeneration(['videos'])} />
        </div>
        <div className={activeTab === 'roadmap' ? 'is-mobile-active' : ''}>
          <RoadmapColumn pack={pack} isActive={activeTab === 'roadmap'} onChanged={() => refreshLearning(taskId).then(() => undefined)} onRetry={() => requestGeneration(['roadmap'])} />
        </div>
      </div>
    </motion.section>
  )
}

export function LearningPackInline({ task }: { task: Task }): React.JSX.Element | null {
  const openTaskId = useNudgeStore((state) => state.openLearningTaskId)
  return openTaskId === task.id ? <LearningPackWorkspace taskId={task.id} /> : null
}
