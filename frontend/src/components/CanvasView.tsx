import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  addManualLink,
  addWaiver,
  attachScd,
  detachScd,
  fetchGraph,
  moveDevice,
  placeDevice,
  removeDevice,
  removeManualLink,
  removeWaiver,
} from '../api'
import { errorMessage } from '../lib/errors'
import { count } from '../lib/format'
import { SOURCE_MIME } from '../lib/sources'
import { GHOST_HUB_ID, buildWires } from '../lib/canvasWires'
import type { WireData } from '../lib/canvasWires'
import { TIER_COLOR, TONE_LABEL, linkTone } from '../lib/tiers'
import type { WireTone } from '../lib/tiers'
import { REF_SEPARATOR } from '../types'
import type {
  CheckStatus,
  DeviceSource,
  GraphDevice,
  GraphGhost,
  GraphLink,
  LinkCheck,
  WorkspaceGraph,
} from '../types'
import { FloatingEdge } from './FloatingEdge'
import { Button, SegmentedControl, Select, TextInput } from './ui'

// The canvas: boxes and colored wires, nothing else. All written detail lives
// in the click popup. Wires are inferred server-side on every graph read —
// the canvas never stores a link. The one exception the user draws by hand:
// dragging from one node's edge to another opens the connect dialog (pick the
// ports), which stores a manual link the linker then validates like any other.

type DeviceNodeData = { name: string; sub: string; ghost?: boolean; scd?: boolean; switch?: boolean }
type DeviceNode = Node<DeviceNodeData, 'device'>

// The ghost hub node's popup lists the referenced devices; a hub WIRE's popup
// lists only its own source's. (The id lives with the wiring rules.)

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

// `carries`: the inferred connections riding this drawn cable. A physical run
// is only interesting because of what travels it, so the wire's popup answers
// that before it answers anything about the cable itself.
type PopupState = { link: GraphLink; carries: GraphLink[]; x: number; y: number }
type NodePopupState = { device: GraphDevice; x: number; y: number }

// The three mutually exclusive canvas popups as one state — opening any one
// structurally closes the others. A ghost popup's `links` carries a hub
// WIRE's own source's declared links; null links = the hub node itself
// (lists every referenced device).
type ActivePopup =
  | ({ kind: 'link' } & PopupState)
  | ({ kind: 'node' } & NodePopupState)
  | { kind: 'ghost'; x: number; y: number; links: GraphLink[] | null }

/** Every canvas popup opens the same way: what it is, its tone, and a way out. */
function PopupHeader({
  title,
  tier,
  onClose,
  closeLabel = 'Close',
}: {
  title: ReactNode
  tier?: WireTone
  onClose: () => void
  closeLabel?: string
}) {
  return (
    <div className="ph">
      <span className="t">{title}</span>
      {tier && (
        <span className="tier-badge" style={{ color: TIER_COLOR[tier] }}>{TONE_LABEL[tier] ?? tier}</span>
      )}
      <button className="x" onClick={onClose} title={closeLabel}>✕</button>
    </div>
  )
}

// Popup geometry: .link-popup is 348px wide; keep it 8px inside the canvas.
const POPUP_WIDTH = 348
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// Beside the node, never under the cursor — the second click of a
// double-click must still land on the node, not on the popup.
function besideNode(wrap: DOMRect, nodeRect: DOMRect) {
  const rightOf = nodeRect.right - wrap.left + 10
  return {
    x: rightOf > wrap.width - (POPUP_WIDTH + 8)
      ? Math.max(nodeRect.left - wrap.left - (POPUP_WIDTH + 10), 8)
      : rightOf,
    y: clamp(nodeRect.top - wrap.top, 8, wrap.height - 190),
  }
}

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
      <PopupHeader title={device.name} onClose={onClose} />
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

// Two modes: from the hub NODE it lists every referenced device; from a hub
// WIRE it lists that source's declared links — each with the linker's own
// summary, far-end lines, and warnings, exactly what LinkPopup shows for a
// resolved link.
function GhostHubPopup({
  ghosts,
  links,
  pos,
  onClose,
}: {
  ghosts: GraphGhost[]
  /** The clicked wire's declared links; null when opened from the hub node. */
  links: GraphLink[] | null
  pos: { x: number; y: number }
  onClose: () => void
}) {
  return (
    <div className="link-popup" style={{ left: pos.x, top: pos.y }}>
      <PopupHeader
        title={links ? 'Declared connections' : 'Referenced devices'}
        tier="declared"
        onClose={onClose}
      />
      <div className="summary">
        {links
          ? `${links.length} declared connection${links.length === 1 ? '' : 's'} whose far end is not on the canvas.`
          : `${ghosts.length} device${ghosts.length === 1 ? '' : 's'} named in loaded settings but not on the canvas — load or place their files to resolve the links.`}
      </div>
      <div className="ghost-list">
        {links
          ? links.map((link) => (
              <div key={link.id} className="ghost-entry">
                <div className="gname">{link.b.label}</div>
                <div className="gsub">{link.summary}</div>
                {link.a.lines.map((line, i) => (
                  <div key={i} className="gline">{line}</div>
                ))}
                {link.checks.map((entry, i) => (
                  <CheckRow key={i} entry={entry} />
                ))}
              </div>
            ))
          : ghosts.map((ghost) => (
              <div key={ghost.id} className="ghost-entry">
                <div className="gname">{ghost.label}</div>
                <div className="gsub">{ghost.sublabel}</div>
                {ghost.lines.map((line, i) => (
                  <div key={i} className="gline">{line}</div>
                ))}
              </div>
            ))}
      </div>
    </div>
  )
}

// A check reads as a line you can scan: a mark, what was looked at, and what
// was found. The mark carries the verdict, so the four statuses stay legible
// at a glance without the reader parsing prose.
const CHECK_MARK: Record<CheckStatus, string> = {
  pass: '✓',
  fail: '✕',
  warn: '!',
  unknown: '–',
}

function CheckRow({ entry }: { entry: LinkCheck }) {
  return (
    <div className={`check ${entry.status}`}>
      <span className="check-mark" aria-hidden>{CHECK_MARK[entry.status]}</span>
      <span className="check-body">
        <span className="check-label">{entry.label}</span>
        <span className="check-detail">{entry.detail}</span>
      </span>
    </div>
  )
}

/** The checklist's own one-line verdict: what the reader should take from it. */
function checkVerdict(checks: LinkCheck[]): { tone: string; text: string } {
  const failed = checks.filter((entry) => entry.status === 'fail').length
  const unknown = checks.filter((entry) => entry.status === 'unknown').length
  const flagged = checks.filter((entry) => entry.status === 'warn').length
  if (failed) return { tone: 'bad', text: `${failed} of ${checks.length} checks failed` }
  if (flagged) return { tone: 'warnc', text: `${flagged} of ${checks.length} checks worth a look` }
  if (unknown) {
    return { tone: 'warnc', text: `${checks.length - unknown} of ${checks.length} checks pass, ${unknown} unanswered` }
  }
  return { tone: 'okc', text: `All ${checks.length} checks pass` }
}

// The acknowledge form: a conflict is waived with a reason, or not at all —
// "known, accepted, because X" is the whole point of the record.
function WaiveForm({ onWaive }: { onWaive: (reason: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <div className="popup-actions waive-form">
      <TextInput
        value={reason}
        placeholder="Why is this acceptable?"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && reason.trim()) onWaive(reason.trim())
        }}
      />
      <Button disabled={!reason.trim()} onClick={() => onWaive(reason.trim())}>
        Acknowledge
      </Button>
    </div>
  )
}

function LinkPopup({
  popup,
  tracedLinkId,
  onTrace,
  onClose,
  onRemove,
  onWaive,
  onUnwaive,
}: {
  popup: PopupState
  tracedLinkId: string | null
  /** Light this connection's whole run across the canvas; null clears it. */
  onTrace: (linkId: string | null) => void
  onClose: () => void
  /** Present only for user-drawn links — inferred wires cannot be removed. */
  onRemove: (manualId: string) => void
  /** Acknowledge this conflict with a reason. */
  onWaive: (linkId: string, reason: string) => void
  /** Reopen an acknowledged conflict. */
  onUnwaive: (waiverId: string) => void
}) {
  const { link, carries } = popup
  const verdict = checkVerdict(link.checks)
  return (
    <div className="link-popup" style={{ left: popup.x, top: popup.y }}>
      <PopupHeader
        title={`${link.a.label.split(' · ')[0]} ⇄ ${link.b.label.split(' · ')[0]}`}
        tier={linkTone(link)}
        onClose={onClose}
      />
      <div className="summary">{link.summary}</div>
      {carries.length > 0 && (
        <>
          <div className="endlabel">
            Carries {count(carries.length, 'connection')}
          </div>
          {carries.map((rider) => (
            <button
              key={rider.id}
              className={`carried ${rider.id === tracedLinkId ? 'selected' : ''}`}
              onClick={() => onTrace(rider.id === tracedLinkId ? null : rider.id)}
              title="Light this connection's whole path"
            >
              <span className="carried-ends">
                {rider.a.label.split(' · ')[0]} ⇄ {rider.b.label.split(' · ')[0]}
              </span>
              <span className="tier-badge" style={{ color: TIER_COLOR[linkTone(rider)] }}>
                {TONE_LABEL[linkTone(rider)] ?? rider.tier}
              </span>
            </button>
          ))}
        </>
      )}
      <div className="endlabel">{link.a.label}</div>
      <div className="endinfo">
        {link.a.lines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
      <div className="endlabel">{link.b.label}</div>
      <div className="endinfo">
        {link.b.lines.map((line, i) => <div key={i}>{line}</div>)}
      </div>
      <div className={`warnhead ${verdict.tone}`}>{verdict.text}</div>
      {link.checks.map((entry, i) => (
        <CheckRow key={i} entry={entry} />
      ))}
      {link.waived ? (
        <>
          <div className="endlabel">
            Acknowledged {new Date(link.waived.at).toLocaleDateString()}
          </div>
          <div className="endinfo">
            <div>{link.waived.reason}</div>
          </div>
          <div className="popup-actions">
            <Button onClick={() => onUnwaive(link.waived!.id)}>Reopen conflict</Button>
          </div>
        </>
      ) : (
        link.tier === 'conflict' && (
          <WaiveForm onWaive={(reason) => onWaive(link.id, reason)} />
        )
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
        <PopupHeader
          title={`${pending.a.name} ⇄ ${pending.b.name}`}
          onClose={onCancel}
          closeLabel="Cancel"
        />
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
  const [nodes, setNodes, onNodesChange] = useNodesState<DeviceNode>([])
  const [activePopup, setActivePopup] = useState<ActivePopup | null>(null)
  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null)
  // Tracing: which wires to light and which to fade back. A connection picked
  // out of a wire's popup pins its whole run; hovering a device lights
  // everything that talks to it. Pinned wins — you asked for that one.
  const [tracedLinkId, setTracedLinkId] = useState<string | null>(null)
  const [hoveredDeviceId, setHoveredDeviceId] = useState<string | null>(null)
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
        ...(next.ghosts.length
          ? [{
              id: GHOST_HUB_ID,
              type: 'device' as const,
              // The hub has no stored position: park it to the right.
              position: { x: 720, y: 60 },
              data: {
                name: `${next.ghosts.length} referenced device${next.ghosts.length === 1 ? '' : 's'}`,
                sub: 'declared in settings · not loaded',
                ghost: true,
              },
              connectable: false,
            }]
          : []),
      ])
    } catch (err) {
      if (seq !== loadSeq.current) return
      setError(errorMessage(err))
      onGraph(null)
    }
  }, [project, onGraph, setNodes])

  useEffect(() => {
    setActivePopup(null)
    load()
  }, [load, reloadKey])

  const edges = useMemo(
    () => buildWires(graph, { tracedLinkId, hoveredDeviceId }),
    [graph, tracedLinkId, hoveredDeviceId],
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
        onNodeMouseEnter={(_e, node) => {
          if (!node.data.ghost) setHoveredDeviceId(node.id)
        }}
        onNodeMouseLeave={() => setHoveredDeviceId(null)}
        onNodeClick={(e, node) => {
          const target = e.target as HTMLElement
          const wrap = target.closest('.canvas-wrap')?.getBoundingClientRect()
          const nodeRect = target.closest('.react-flow__node')?.getBoundingClientRect()
          if (!wrap || !nodeRect) return
          if (node.data.ghost) {
            setActivePopup({ kind: 'ghost', ...besideNode(wrap, nodeRect), links: null })
            return
          }
          const device = graph?.devices.find((d) => d.id === node.id)
          if (!device) return
          setActivePopup({ kind: 'node', device, ...besideNode(wrap, nodeRect) })
        }}
        onNodeDoubleClick={(_e, node) => {
          if (node.data.ghost) return
          const device = graph?.devices.find((d) => d.id === node.id)
          if (device && !device.error) {
            setActivePopup(null)
            onInspect(device.source)
          }
        }}
        onEdgeClick={(e, edge) => {
          const wrap = (e.target as HTMLElement).closest('.canvas-wrap')?.getBoundingClientRect()
          if (!wrap) return
          const data = edge.data as WireData | undefined
          const at = {
            x: clamp(e.clientX - wrap.left - 170, 8, wrap.width - (POPUP_WIDTH + 8)),
            y: clamp(e.clientY - wrap.top - 30, 8, wrap.height - 300),
          }
          if (data?.hubLinks) {
            // The collapsed ghost wire lists its own source's declared links.
            setActivePopup({ kind: 'ghost', ...at, links: data.hubLinks })
            return
          }
          if (!data?.link) return
          setActivePopup({ kind: 'link', link: data.link, carries: data.carries ?? [], ...at })
        }}
        onConnect={({ source, target }) => {
          if (!source || !target || source === target) return
          const a = graph?.devices.find((d) => d.id === source)
          const b = graph?.devices.find((d) => d.id === target)
          if (!a || !b) return // ghosts (and unknown ids) take no drawn wires
          setActivePopup(null)
          setPendingConnect({ a, b })
        }}
        onPaneClick={() => {
          setActivePopup(null)
          setTracedLinkId(null)
        }}
        deleteKeyCode={['Backspace', 'Delete']}
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
      {activePopup?.kind === 'link' && (
        <LinkPopup
          popup={activePopup}
          tracedLinkId={tracedLinkId}
          onTrace={setTracedLinkId}
          onClose={() => {
            setActivePopup(null)
            setTracedLinkId(null)
          }}
          onRemove={async (manualId) => {
            setActivePopup(null)
            setTracedLinkId(null)
            await removeManualLink(project, manualId).catch((err) => setError(errorMessage(err)))
            await load()
          }}
          onWaive={async (linkId, reason) => {
            setActivePopup(null)
            setTracedLinkId(null)
            await addWaiver(project, linkId, reason).catch((err) => setError(errorMessage(err)))
            await load()
          }}
          onUnwaive={async (waiverId) => {
            setActivePopup(null)
            setTracedLinkId(null)
            await removeWaiver(project, waiverId).catch((err) => setError(errorMessage(err)))
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
      {activePopup?.kind === 'node' && (
        <NodePopup
          popup={activePopup}
          onClose={() => setActivePopup(null)}
          onDetachScd={async (deviceId) => {
            setActivePopup(null)
            await detachScd(project, deviceId).catch((err) => setError(errorMessage(err)))
            await load()
          }}
        />
      )}
      {activePopup?.kind === 'ghost' && graph && (
        <GhostHubPopup
          ghosts={graph.ghosts}
          links={activePopup.links}
          pos={activePopup}
          onClose={() => setActivePopup(null)}
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
