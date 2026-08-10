import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

import {
  addManualLink,
  attachScd,
  detachScd,
  fetchGraph,
  moveDevice,
  placeDevice,
  removeDevice,
  removeManualLink,
} from '../api'
import { errorMessage } from '../lib/errors'
import { SOURCE_MIME } from '../lib/sources'
import { TIER_COLOR, TIER_DASH } from '../lib/tiers'
import { REF_SEPARATOR } from '../types'
import type { DeviceSource, GraphDevice, GraphLink, WorkspaceGraph } from '../types'
import { FloatingEdge } from './FloatingEdge'
import { Button, SegmentedControl, Select, TextInput } from './ui'

// The canvas: boxes and colored wires, nothing else. All written detail lives
// in the click popup. Wires are inferred server-side on every graph read —
// the canvas never stores a link. The one exception the user draws by hand:
// dragging from one node's edge to another opens the connect dialog (pick the
// ports), which stores a manual link the linker then validates like any other.

type DeviceNodeData = { name: string; sub: string; ghost?: boolean; scd?: boolean; switch?: boolean }
type DeviceNode = Node<DeviceNodeData, 'device'>

function DeviceNodeView({ data }: NodeProps<DeviceNode>) {
  const classes = ['canvas-node']
  if (data.ghost) classes.push('ghost')
  if (data.switch) classes.push('switch')
  return (
    <div className={classes.join(' ')}>
      <Handle type="target" position={Position.Left} className="node-handle" />
      <div className="nm">
        {data.name}
        {data.switch && <span className="node-scd">SW</span>}
        {data.scd && <span className="node-scd">SCD</span>}
      </div>
      <div className="sub">{data.sub}</div>
      <Handle type="source" position={Position.Right} className="node-handle" />
    </div>
  )
}

const NODE_TYPES = { device: DeviceNodeView }
const EDGE_TYPES = { floating: FloatingEdge }

type PopupState = { link: GraphLink; x: number; y: number }
type NodePopupState = { device: GraphDevice; x: number; y: number }

// Popup geometry: .link-popup is 348px wide; keep it 8px inside the canvas.
const POPUP_WIDTH = 348
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** What kind of box this is, when the profile states nothing better. */
const deviceModelLabel = (device: GraphDevice) => device.model ?? device.source.type.toUpperCase()

// Which settings artifact a canvas node is built from, as one line. Upload
// refs are "<fileId>::<profileName>" — the fileId is shown as-is (its real
// extension was stripped at upload; fabricating one here would lie about
// .cid/.icd files).
const PROFILE_NOUN: Partial<Record<DeviceSource['type'], string>> = {
  rdb: 'profile',
  scd: 'IED',
}

function sourceLine(source: DeviceSource): string {
  const noun = PROFILE_NOUN[source.type]
  const at = source.ref.indexOf(REF_SEPARATOR)
  if (noun && at > 0) {
    return `${source.ref.slice(0, at)} · ${noun} ${source.ref.slice(at + REF_SEPARATOR.length)}`
  }
  if (source.type === 'rtac') return `RTAC export · ${source.ref}`
  return `${source.type} · ${source.ref}`
}

function NodePopup({
  popup,
  onClose,
  onDetachScd,
}: {
  popup: NodePopupState
  onClose: () => void
  onDetachScd: (deviceId: string) => void
}) {
  const { device } = popup
  return (
    <div className="link-popup" style={{ left: popup.x, top: popup.y }}>
      <div className="ph">
        <span className="t">{device.name}</span>
        <button className="x" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="summary">
        {deviceModelLabel(device)}
        {device.endpointCount !== undefined &&
          ` · ${device.endpointCount} comm endpoint${device.endpointCount === 1 ? '' : 's'}`}
      </div>
      <div className="endlabel">Settings source</div>
      <div className="endinfo">
        <div>{sourceLine(device.source)}</div>
      </div>
      {device.scd && (
        <>
          <div className="endlabel">SCD attachment</div>
          <div className="endinfo scd-attachment">
            <div>{sourceLine({ type: 'scd', ref: device.scd.ref })}</div>
            <button className="x" title="Detach the SCD profile" onClick={() => onDetachScd(device.id)}>
              ✕
            </button>
          </div>
          {device.scd.error && <div className="warn bad">{device.scd.error}</div>}
          {device.scd.warning && <div className="warn warnc">{device.scd.warning}</div>}
        </>
      )}
      {device.error ? (
        <div className="warn bad">{device.error}</div>
      ) : (
        <div className="endlabel">Double-click to open in Inspect</div>
      )}
    </div>
  )
}

function LinkPopup({
  popup,
  onClose,
  onRemove,
}: {
  popup: PopupState
  onClose: () => void
  /** Present only for user-drawn links — inferred wires cannot be removed. */
  onRemove: (manualId: string) => void
}) {
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
      {link.manualId && (
        <div className="popup-actions">
          <Button onClick={() => onRemove(link.manualId!)}>Remove connection</Button>
        </div>
      )}
    </div>
  )
}

// --- drawing a connection ------------------------------------------------------

type PendingConnect = { a: GraphDevice; b: GraphDevice }

// One side's port choice: a dropdown when the device states its ports (a
// switch's eth1..ethN), free text otherwise (a relay's own port label).
function PortField({
  device,
  value,
  onChange,
}: {
  device: GraphDevice
  value: string
  onChange: (value: string) => void
}) {
  if (device.ports?.length) {
    return (
      <Select
        label={`${device.name} port`}
        value={value}
        onChange={onChange}
        placeholder="— pick a port —"
        options={device.ports.map((port) => ({
          value: port.id,
          label: [
            port.id,
            port.name && `— ${port.name}`,
            !port.enabled && '(disabled)',
          ].filter(Boolean).join(' '),
        }))}
      />
    )
  }
  return (
    <TextInput
      label={`${device.name} port`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="optional — e.g. Port 5"
    />
  )
}

// One side's serial line choice, from the device's own serial endpoints.
function SerialField({
  device,
  value,
  onChange,
}: {
  device: GraphDevice
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select
      label={`${device.name} serial line`}
      value={value}
      onChange={onChange}
      placeholder="— pick a line —"
      options={(device.serialEndpoints ?? []).map((endpoint) => ({
        value: endpoint.id,
        label: endpoint.detail ? `${endpoint.name} — ${endpoint.detail}` : endpoint.name,
      }))}
    />
  )
}

type ConnectRequest =
  | { type: 'ethernet'; aPort?: string; bPort?: string }
  | { type: 'serial'; aEndpointId: string; bEndpointId: string }

function ConnectDialog({
  pending,
  onCancel,
  onConnect,
}: {
  pending: PendingConnect
  onCancel: () => void
  onConnect: (request: ConnectRequest) => void
}) {
  // Serial pairing is offered when both ends state serial lines and neither
  // is a switch; two relays wired directly usually means a serial run.
  const serialPossible = Boolean(
    pending.a.serialEndpoints?.length
      && pending.b.serialEndpoints?.length
      && pending.a.kind !== 'switch'
      && pending.b.kind !== 'switch',
  )
  const [mode, setMode] = useState<'ethernet' | 'serial'>(
    serialPossible && !pending.a.ports?.length && !pending.b.ports?.length ? 'serial' : 'ethernet',
  )
  const [aPort, setAPort] = useState('')
  const [bPort, setBPort] = useState('')
  const [aEndpoint, setAEndpoint] = useState('')
  const [bEndpoint, setBEndpoint] = useState('')
  // Ethernet: a device that states its ports must have one picked; free text
  // is optional. Serial: both lines must be picked.
  const ready = mode === 'ethernet'
    ? (!pending.a.ports?.length || aPort) && (!pending.b.ports?.length || bPort)
    : aEndpoint && bEndpoint
  return (
    <div className="connect-overlay" onClick={onCancel}>
      <div className="link-popup connect-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="ph">
          <span className="t">{pending.a.name} ⇄ {pending.b.name}</span>
          <button className="x" onClick={onCancel} title="Cancel">✕</button>
        </div>
        <div className="summary">
          {mode === 'ethernet'
            ? 'Draw a physical connection — pick the port on each end.'
            : 'Pair two serial lines — pick the line on each end.'}
        </div>
        <div className="connect-fields">
          {serialPossible && (
            <SegmentedControl
              options={[
                { value: 'ethernet' as const, label: 'Ethernet' },
                { value: 'serial' as const, label: 'Serial' },
              ]}
              value={mode}
              onChange={setMode}
            />
          )}
          {mode === 'ethernet' ? (
            <>
              <PortField device={pending.a} value={aPort} onChange={setAPort} />
              <PortField device={pending.b} value={bPort} onChange={setBPort} />
            </>
          ) : (
            <>
              <SerialField device={pending.a} value={aEndpoint} onChange={setAEndpoint} />
              <SerialField device={pending.b} value={bEndpoint} onChange={setBEndpoint} />
            </>
          )}
        </div>
        <div className="popup-actions">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => onConnect(
              mode === 'ethernet'
                ? { type: 'ethernet', aPort: aPort || undefined, bPort: bPort || undefined }
                : { type: 'serial', aEndpointId: aEndpoint, bEndpointId: bEndpoint },
            )}
          >
            Connect
          </Button>
        </div>
      </div>
    </div>
  )
}

function CanvasInner({
  project,
  reloadKey,
  onInspect,
  onGraph,
}: {
  project: string
  /** Bump to force a graph reload (e.g. after an RDB upload resolves ghosts). */
  reloadKey: number
  onInspect: (source: DeviceSource) => void
  onGraph: (graph: WorkspaceGraph | null) => void
}) {
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<DeviceNode[]>([])
  const [popup, setPopup] = useState<PopupState | null>(null)
  const [nodePopup, setNodePopup] = useState<NodePopupState | null>(null)
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null)
  const { screenToFlowPosition } = useReactFlow()
  // Loads can overlap (StrictMode double-mount, drop + upload back to back);
  // only the latest response may write state, or React Flow can validate
  // edges against a node set that is about to be replaced.
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const next = await fetchGraph(project)
      if (seq !== loadSeq.current) return
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
            sub: device.error ?? `${deviceModelLabel(device)} · ${device.source.ref}`,
            scd: Boolean(device.scd),
            switch: device.kind === 'switch',
          },
        })),
        ...next.ghosts.map<DeviceNode>((ghost, i) => ({
          id: ghost.id,
          type: 'device',
          // Ghosts have no stored position: park them in a column to the right.
          position: { x: 720, y: 60 + i * 96 },
          data: { name: ghost.label, sub: ghost.sublabel, ghost: true },
          connectable: false,
        })),
      ])
    } catch (err) {
      if (seq !== loadSeq.current) return
      setError(errorMessage(err))
      onGraph(null)
    }
  }, [project, onGraph])

  useEffect(() => {
    setPopup(null)
    setNodePopup(null)
    load()
  }, [load, reloadKey])

  const edges = useMemo<Edge[]>(
    () =>
      (graph?.links ?? []).map((link) => ({
        id: link.id,
        source: link.sourceDeviceId,
        target: link.targetDeviceId ?? link.targetGhostId ?? '',
        type: 'floating',
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

        // An SCD profile dropped ONTO a placed device augments it — the same
        // physical device seen by a second document. Anywhere else (including
        // any non-SCD source) places a node as usual.
        const nodeId = (e.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id')
        if (source.type === 'scd' && nodeId && graph?.devices.some((d) => d.id === nodeId)) {
          await attachScd(project, nodeId, source.ref).catch((err) => setError(errorMessage(err)))
          await load()
          return
        }

        const position = screenToFlowPosition({ x: e.clientX, y: e.clientY })
        await placeDevice(project, source, Math.round(position.x), Math.round(position.y)).catch(
          (err) => setError(errorMessage(err)),
        )
        await load()
      }}
    >
      {error && <div className="canvas-error">{error}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_e, node) => {
          if (!node.data.ghost) {
            moveDevice(project, node.id, Math.round(node.position.x), Math.round(node.position.y)).catch(() => undefined)
          }
        }}
        onNodeClick={(e, node) => {
          if (node.data.ghost) return
          const target = e.target as HTMLElement
          const wrap = target.closest('.canvas-wrap')?.getBoundingClientRect()
          const nodeRect = target.closest('.react-flow__node')?.getBoundingClientRect()
          const device = graph?.devices.find((d) => d.id === node.id)
          if (!device || !wrap || !nodeRect) return
          setPopup(null)
          // Beside the node, never under the cursor — the second click of a
          // double-click must still land on the node, not on this popup.
          const rightOf = nodeRect.right - wrap.left + 10
          setNodePopup({
            device,
            x: rightOf > wrap.width - (POPUP_WIDTH + 8)
              ? Math.max(nodeRect.left - wrap.left - (POPUP_WIDTH + 10), 8)
              : rightOf,
            y: clamp(nodeRect.top - wrap.top, 8, wrap.height - 190),
          })
        }}
        onNodeDoubleClick={(_e, node) => {
          if (node.data.ghost) return
          const device = graph?.devices.find((d) => d.id === node.id)
          if (device && !device.error) {
            setNodePopup(null)
            onInspect(device.source)
          }
        }}
        onEdgeClick={(e, edge) => {
          const wrap = (e.target as HTMLElement).closest('.canvas-wrap')?.getBoundingClientRect()
          const link = (edge.data as { link: GraphLink } | undefined)?.link
          if (!link || !wrap) return
          setNodePopup(null)
          setPopup({
            link,
            x: clamp(e.clientX - wrap.left - 170, 8, wrap.width - (POPUP_WIDTH + 8)),
            y: clamp(e.clientY - wrap.top - 30, 8, wrap.height - 300),
          })
        }}
        onConnect={({ source, target }) => {
          if (!source || !target || source === target) return
          const a = graph?.devices.find((d) => d.id === source)
          const b = graph?.devices.find((d) => d.id === target)
          if (!a || !b) return // ghosts (and unknown ids) take no drawn wires
          setPopup(null)
          setNodePopup(null)
          setPendingConnect({ a, b })
        }}
        onPaneClick={() => {
          setPopup(null)
          setNodePopup(null)
        }}
        onNodesDelete={async (deleted) => {
          await Promise.all(
            deleted
              .filter((node) => !node.data.ghost)
              .map((node) => removeDevice(project, node.id).catch(() => undefined)),
          )
          await load()
        }}
        fitView={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={26} size={1.5} color="#dfe2e8" />
      </ReactFlow>
      {popup && (
        <LinkPopup
          popup={popup}
          onClose={() => setPopup(null)}
          onRemove={async (manualId) => {
            setPopup(null)
            await removeManualLink(project, manualId).catch((err) => setError(errorMessage(err)))
            await load()
          }}
        />
      )}
      {pendingConnect && (
        <ConnectDialog
          pending={pendingConnect}
          onCancel={() => setPendingConnect(null)}
          onConnect={async (request) => {
            setPendingConnect(null)
            await addManualLink(project, {
              ...request,
              aDeviceId: pendingConnect.a.id,
              bDeviceId: pendingConnect.b.id,
            }).catch((err) => setError(errorMessage(err)))
            await load()
          }}
        />
      )}
      {nodePopup && (
        <NodePopup
          popup={nodePopup}
          onClose={() => setNodePopup(null)}
          onDetachScd={async (deviceId) => {
            setNodePopup(null)
            await detachScd(project, deviceId).catch((err) => setError(errorMessage(err)))
            await load()
          }}
        />
      )}
    </div>
  )
}

export function CanvasView(props: {
  project: string
  reloadKey: number
  onInspect: (source: DeviceSource) => void
  onGraph: (graph: WorkspaceGraph | null) => void
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  )
}
