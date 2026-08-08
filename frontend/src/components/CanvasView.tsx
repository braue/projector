import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { fetchGraph, moveDevice, placeDevice, removeDevice } from '../api'
import type { GraphLink, LinkTier, WorkspaceGraph } from '../types'
import { SOURCE_MIME } from './SourcesSidebar'

// The canvas: boxes and colored wires, nothing else. All written detail lives
// in the click popup. Wires are inferred server-side on every graph read —
// the canvas never stores a link.

const TIER_COLOR: Record<LinkTier, string> = {
  confirmed: '#1a9e5c',
  conflict: '#d63a3a',
  probable: '#d7930a',
  declared: '#a9adb8',
  manual: '#4b5160',
}

const TIER_DASH: Partial<Record<LinkTier, string>> = {
  probable: '7 5',
  declared: '4 4',
}

type DeviceNodeData = { name: string; sub: string; error?: string; ghost?: boolean }
type DeviceNode = Node<DeviceNodeData, 'device'>

function DeviceNodeView({ data }: NodeProps<DeviceNode>) {
  return (
    <div className={data.ghost ? 'canvas-node ghost' : 'canvas-node'}>
      <Handle type="target" position={Position.Left} className="node-handle" />
      <div className="nm">{data.name}</div>
      <div className="sub">{data.error ?? data.sub}</div>
      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  )
}

const NODE_TYPES = { device: DeviceNodeView }

type PopupState = { link: GraphLink; x: number; y: number }

function LinkPopup({ popup, onClose }: { popup: PopupState; onClose: () => void }) {
  const { link } = popup
  const errors = link.warnings.filter((w) => w.kind === 'error')
  const tone = errors.length ? 'bad' : link.warnings.length ? 'warnc' : 'okc'
  return (
    <div className="link-popup" style={{ left: popup.x, top: popup.y }}>
      <div className="ph">
        <span className="t">{link.a.label.split(' · ')[0]} ⇄ {link.b.label.split(' · ')[0]}</span>
        <span className="tier-badge" style={{ color: TIER_COLOR[link.tier] }}>
          {link.tier}
        </span>
        <button className="x" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="summary">{link.summary}</div>
      <div className="endlabel">{link.a.label}</div>
      <div className="endinfo">
        {link.a.lines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
      <div className="endlabel">{link.b.label}</div>
      <div className="endinfo">
        {link.b.lines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
      <div className={`warnhead ${tone}`}>
        {link.warnings.length
          ? `${errors.length ? `${errors.length} error${errors.length > 1 ? 's' : ''}` : `${link.warnings.length} warning${link.warnings.length > 1 ? 's' : ''}`}`
          : 'Checks'}
      </div>
      {link.warnings.length ? (
        link.warnings.map((w, i) => (
          <div key={i} className={`warn ${w.kind === 'error' ? 'bad' : 'warnc'}`}>{w.text}</div>
        ))
      ) : (
        <div className="clean">No warnings — both ends agree.</div>
      )}
    </div>
  )
}

function CanvasInner({
  workspace,
  onInspect,
  onGraph,
}: {
  workspace: string
  onInspect: (ref: string) => void
  onGraph: (graph: WorkspaceGraph | null) => void
}) {
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<DeviceNode[]>([])
  const [popup, setPopup] = useState<PopupState | null>(null)
  const { screenToFlowPosition } = useReactFlow()

  const load = useCallback(async () => {
    try {
      const next = await fetchGraph(workspace)
      setGraph(next)
      setError(null)
      onGraph(next)
      setNodes([
        ...next.devices.map<DeviceNode>((device) => ({
          id: device.id,
          type: 'device',
          position: { x: device.x, y: device.y },
          data: {
            name: device.name,
            sub: device.error ?? `${device.model ?? device.source.type.toUpperCase()} · ${device.source.ref}`,
            error: device.error,
          },
        })),
        ...next.ghosts.map<DeviceNode>((ghost, i) => ({
          id: ghost.id,
          type: 'device',
          // Ghosts have no stored position: park them in a column to the right.
          position: { x: 720, y: 60 + i * 96 },
          data: { name: ghost.label, sub: ghost.sublabel, ghost: true },
        })),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      onGraph(null)
    }
  }, [workspace, onGraph])

  useEffect(() => {
    setPopup(null)
    load()
  }, [load])

  const edges = useMemo<Edge[]>(
    () =>
      (graph?.links ?? []).map((link) => ({
        id: link.id,
        source: link.sourceDeviceId,
        target: link.targetDeviceId ?? link.targetGhostId ?? '',
        type: 'straight',
        style: {
          stroke: TIER_COLOR[link.tier],
          strokeWidth: 2,
          strokeDasharray: TIER_DASH[link.tier],
        },
        data: { link },
        interactionWidth: 16,
      })),
    [graph],
  )

  const onNodesChange = useCallback(
    (changes: NodeChange<DeviceNode>[]) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  )

  return (
    <div
      className="canvas-wrap"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SOURCE_MIME)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={async (e) => {
        const raw = e.dataTransfer.getData(SOURCE_MIME)
        if (!raw) return
        e.preventDefault()
        const source = JSON.parse(raw)
        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        await placeDevice(workspace, source, Math.round(position.x), Math.round(position.y)).catch(
          (err) => setError(err instanceof Error ? err.message : String(err)),
        )
        await load()
      }}
    >
      {error && <div className="canvas-error">{error}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_e, node) => {
          if (!node.data.ghost) {
            moveDevice(workspace, node.id, Math.round(node.position.x), Math.round(node.position.y)).catch(() => undefined)
          }
        }}
        onNodeClick={(_e, node) => {
          if (node.data.ghost) return
          const device = graph?.devices.find((d) => d.id === node.id)
          if (device?.source.type === 'rtac') onInspect(device.source.ref)
        }}
        onEdgeClick={(e, edge) => {
          const wrap = (e.target as HTMLElement).closest('.canvas-wrap')?.getBoundingClientRect()
          const link = (edge.data as { link: GraphLink } | undefined)?.link
          if (!link || !wrap) return
          setPopup({
            link,
            x: Math.min(Math.max(e.clientX - wrap.left - 170, 8), wrap.width - 356),
            y: Math.min(Math.max(e.clientY - wrap.top - 30, 8), wrap.height - 300),
          })
        }}
        onPaneClick={() => setPopup(null)}
        onNodesDelete={async (deleted) => {
          for (const node of deleted) {
            if (!node.data.ghost) await removeDevice(workspace, node.id).catch(() => undefined)
          }
          await load()
        }}
        fitView={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={26} size={1.5} color="#dfe2e8" />
      </ReactFlow>
      {popup && <LinkPopup popup={popup} onClose={() => setPopup(null)} />}
    </div>
  )
}

export function CanvasView(props: {
  workspace: string
  onInspect: (ref: string) => void
  onGraph: (graph: WorkspaceGraph | null) => void
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
