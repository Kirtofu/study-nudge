import type { LearningNode, LearningPack } from '@shared/types'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Check,
  CircleDashed,
  GitBranch,
  LayoutDashboard,
  List,
  LoaderCircle,
  Plus,
  RefreshCw,
  Route,
  Save,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../../bridge'
import { useToast } from '../../components/Toast'
import { useNudgeStore } from '../../store'

import { useRetainedForm } from '../../state/use-retained-form'
import { nextNodeStatus, type UndoAction } from './model'

type RoadmapNodeData = {
  learningNode: LearningNode
  onSelect: (node: LearningNode) => void
  onToggleStatus: (node: LearningNode) => void
}
type RoadmapFlowNode = Node<RoadmapNodeData, 'roadmap'>

function RoadmapNodeCard({ data, selected }: NodeProps<RoadmapFlowNode>): React.JSX.Element {
  const node = data.learningNode
  return (
    <div
      className={`roadmap-node-card node-${node.status} ${selected ? 'is-selected' : ''}`}
      onDoubleClick={() => data.onSelect(node)}
    >
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
  for (const edge of edges)
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
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

function NodeInspector({
  node,
  onSaved,
  onDelete
}: {
  node: LearningNode
  onSaved: () => Promise<void>
  onDelete: (node: LearningNode) => void
}): React.JSX.Element {
  const [draft, setDraft] = useRetainedForm({
    title: node.title,
    description: node.description,
    estimatedMinutes: node.estimatedMinutes?.toString() ?? ''
  })
  const [saving, setSaving] = useState(false)
  const showToast = useToast()
  return (
    <form
      className="node-inspector"
      onSubmit={(event) => {
        event.preventDefault()
        setSaving(true)
        void api.learning.roadmap
          .upsertNode(node.taskId, {
            ...node,
            title: draft.title.trim(),
            description: draft.description.trim(),
            estimatedMinutes: draft.estimatedMinutes ? Number(draft.estimatedMinutes) : null
          })
          .then(onSaved)
          .then(() => showToast({ message: '路线节点已保存' }))
          .catch((error) => {
            showToast({
              message: '节点没有保存',
              detail: error instanceof Error ? error.message : '请检查内容'
            })
          })
          .finally(() => setSaving(false))
      }}
    >
      <label>
        <span>节点名称</span>
        <input
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          maxLength={120}
        />
      </label>
      <label>
        <span>说明</span>
        <textarea
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          rows={2}
        />
      </label>
      <label>
        <span>预计分钟</span>
        <input
          type="number"
          min="1"
          max="100000"
          value={draft.estimatedMinutes}
          onChange={(event) => setDraft({ ...draft, estimatedMinutes: event.target.value })}
        />
      </label>
      <div className="node-inspector-actions">
        <button type="button" className="text-button danger-text" onClick={() => onDelete(node)}>
          <Trash2 size={13} />
          删除
        </button>
        <button type="submit" className="compact-primary" disabled={saving || !draft.title.trim()}>
          <Save size={13} />
          {saving ? '保存中…' : '保存节点'}
        </button>
      </div>
    </form>
  )
}

export function RoadmapColumn({
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
  const initializedViewport = useRef(false)
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
    pushUndo({
      label: `恢复“${node.title}”状态`,
      run: async () => {
        await api.learning.roadmap.setStatus(node.id, previous)
        await onChanged()
      }
    })
    await onChanged()
  }

  useEffect(() => {
    setFlowNodes(
      pack.nodes.map((node) => ({
        id: node.id,
        type: 'roadmap',
        position: { x: node.x, y: node.y },
        data: {
          learningNode: node,
          onSelect: (next) => setSelectedNodeId(next.id),
          onToggleStatus: (next) => void toggleNodeStatus(next)
        }
      }))
    )
    setFlowEdges(
      pack.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        className: 'roadmap-edge'
      }))
    )
  }, [pack])

  useEffect(() => {
    if (!isActive || view !== 'graph' || !flowNodes.length || initializedViewport.current) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const first = flowNodes[0].position
        if (flowInstance.current) {
          // Start at readable text size. The explicit overview control can fit
          // the whole graph without making every visit shrink long roadmaps.
          void flowInstance.current.setViewport({ x: 24 - first.x, y: 24 - first.y, zoom: 1 })
          initializedViewport.current = true
        }
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
      pushUndo({
        label: '撤销节点连接',
        run: async () => {
          await api.learning.roadmap.disconnect(edge.id)
          await onChanged()
        }
      })
      await onChanged()
    } catch (error) {
      showToast({
        message: '节点没有连接',
        detail: error instanceof Error ? error.message : '请换一个连接方向'
      })
    }
  }

  const autoLayout = async (): Promise<void> => {
    const previous = pack.nodes.map((node) => ({
      id: node.id,
      x: node.x,
      y: node.y,
      title: node.title
    }))
    try {
      const next = await api.learning.roadmap.autoLayout(pack.taskId)
      useNudgeStore.setState((state) => ({
        learningPacks: { ...state.learningPacks, [pack.taskId]: next }
      }))
      pushUndo({
        label: '撤销自动布局',
        run: async () => {
          await Promise.all(
            previous.map((node) => {
              const current = next.nodes.find((item) => item.id === node.id)!
              return api.learning.roadmap.upsertNode(pack.taskId, {
                ...current,
                x: node.x,
                y: node.y,
                title: current.title
              })
            })
          )
          await onChanged()
        }
      })
      showToast({ message: '路线图已经自动排版' })
    } catch (error) {
      showToast({
        message: '路线图没有排版成功',
        detail: error instanceof Error ? error.message : '请稍后重试'
      })
    }
  }

  const addNode = async (): Promise<void> => {
    if (!newTitle.trim()) return
    const node = await api.learning.roadmap.upsertNode(pack.taskId, {
      title: newTitle.trim(),
      kind: 'custom',
      description: '',
      status: 'pending',
      x: 40,
      y: 40 + pack.nodes.length * 96,
      position: (pack.nodes.length + 1) * 1000
    })
    pushUndo({
      label: `删除“${node.title}”`,
      run: async () => {
        await api.learning.roadmap.deleteNode(node.id)
        await onChanged()
      }
    })
    setNewTitle('')
    setAdding(false)
    await onChanged()
    setSelectedNodeId(node.id)
  }

  const deleteNode = (node: LearningNode): void => {
    if (!window.confirm(`删除路线节点“${node.title}”？关联连线也会移除。`)) return
    const related = pack.edges.filter(
      (edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id
    )
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
    <section
      className="learning-column learning-column-roadmap"
      aria-labelledby={`learning-roadmap-${pack.id}`}
    >
      <div className="learning-column-header roadmap-header">
        <div className="learning-column-heading">
          <span className="learning-column-icon">
            <Route size={17} />
          </span>
          <div>
            <h3 id={`learning-roadmap-${pack.id}`}>学习路线</h3>
            <p>拖动节点，连接依赖，按步骤推进</p>
          </div>
        </div>
        <div className="learning-column-tools">
          <button
            type="button"
            className="segmented-icon"
            aria-pressed={view === 'graph'}
            onClick={() => setView('graph')}
            title="图表视图"
          >
            <LayoutDashboard size={14} />
          </button>
          <button
            type="button"
            className="segmented-icon"
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
            title="列表视图"
          >
            <List size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void autoLayout()}
            aria-label="自动布局"
          >
            <GitBranch size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={!undoStack.current.length}
            onClick={() => {
              const action = undoStack.current.pop()
              setUndoVersion(undoVersion + 1)
              if (action) void action.run().then(() => showToast({ message: action.label }))
            }}
            aria-label="撤销路线操作"
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onRetry}
            aria-label="重新生成学习路线"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setAdding((value) => !value)}
            aria-label="添加路线节点"
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
      {adding ? (
        <form
          className="roadmap-quick-add"
          onSubmit={(event) => {
            event.preventDefault()
            void addNode()
          }}
        >
          <input
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            placeholder="新增一个学习步骤…"
            autoFocus
            maxLength={120}
          />
          <button type="submit" className="compact-primary" disabled={!newTitle.trim()}>
            <Plus size={13} />
            添加
          </button>
        </form>
      ) : null}
      <div className={`roadmap-workspace is-${view}`}>
        {view === 'graph' ? (
          <div className="roadmap-canvas" aria-label="可编辑学习路线图">
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              defaultViewport={{
                x: 24 - (pack.nodes[0]?.x ?? 0),
                y: 24 - (pack.nodes[0]?.y ?? 0),
                zoom: 1
              }}
              ariaLabelConfig={{
                'controls.fitView.ariaLabel': '显示全图',
                'controls.zoomIn.ariaLabel': '放大路线',
                'controls.zoomOut.ariaLabel': '缩小路线'
              }}
              onInit={(instance) => {
                flowInstance.current = instance
              }}
              minZoom={0.35}
              maxZoom={1.8}
              snapToGrid
              snapGrid={[8, 8]}
              onNodesChange={(changes: NodeChange<RoadmapFlowNode>[]) =>
                setFlowNodes((nodes) => applyNodeChanges(changes, nodes))
              }
              onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
              onNodeDragStop={(_event, flowNode) => {
                const node = pack.nodes.find((item) => item.id === flowNode.id)
                if (!node) return
                const previous = { x: node.x, y: node.y }
                void api.learning.roadmap
                  .upsertNode(pack.taskId, {
                    ...node,
                    x: flowNode.position.x,
                    y: flowNode.position.y
                  })
                  .then(async () => {
                    pushUndo({
                      label: `恢复“${node.title}”位置`,
                      run: async () => {
                        await api.learning.roadmap.upsertNode(pack.taskId, { ...node, ...previous })
                        await onChanged()
                      }
                    })
                    await onChanged()
                  })
              }}
              onConnect={(connection) => void connect(connection)}
              onEdgesDelete={(edges) => {
                edges.forEach((edge) => {
                  const existing = pack.edges.find((item) => item.id === edge.id)
                  void api.learning.roadmap.disconnect(edge.id).then(async () => {
                    if (existing)
                      pushUndo({
                        label: '恢复节点连接',
                        run: async () => {
                          await api.learning.roadmap.connect(
                            pack.id,
                            existing.sourceNodeId,
                            existing.targetNodeId
                          )
                          await onChanged()
                        }
                      })
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
                <button
                  type="button"
                  className="roadmap-list-check"
                  onClick={() => void toggleNodeStatus(node)}
                  aria-label={`切换“${node.title}”状态`}
                >
                  {node.status === 'completed' ? <Check size={13} /> : index + 1}
                </button>
                <button
                  type="button"
                  className="roadmap-list-copy"
                  onClick={() => setSelectedNodeId(node.id)}
                >
                  <strong>{node.title}</strong>
                  <span>{node.description || '补充这个步骤的说明'}</span>
                </button>
                <small>{node.estimatedMinutes ? `${node.estimatedMinutes} 分钟` : '未估时'}</small>
              </li>
            ))}
          </ol>
        )}
        {selectedNode ? (
          <NodeInspector
            key={selectedNode.id}
            node={selectedNode}
            onSaved={onChanged}
            onDelete={deleteNode}
          />
        ) : null}
      </div>
    </section>
  )
}
