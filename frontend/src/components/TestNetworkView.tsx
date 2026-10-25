// The Test pane — the bench network as it stands. The SEL-2730M's VLAN table
// says which port is on which VLAN; the bench device table says who is on
// that port; each RTAC's web interface says its Eth_02 address and running
// project. Drawn as the switch's faceplate over one lane per VLAN. Dragging
// a card onto another lane moves its switch port to that VLAN, on the switch,
// at once. Clicking an RTAC picks an AcRTAC database project to upload to it
// (a job, in the AcRTAC queue).

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import {
  fetchBenchDevices,
  fetchTestNetwork,
  moveTestDevice,
  saveBenchDevices,
  scanTestNetwork,
  uploadToTestRtac,
  type BenchDevice,
  type TestDeviceState,
  type TestScan,
} from '../api'
import { errorMessage } from '../lib/errors'
import { onEvent } from '../lib/events'
import { formatStamp } from '../lib/format'
import { useJobs } from '../lib/jobs'
import { saveSettings, setting } from '../lib/settings'
import { useAction } from '../lib/useAction'
import { AcrtacProjectList } from './AcrtacProjectList'
import { Button, Modal, RowAction, Select, Spinner, TextInput } from './ui'

const SETTINGS_KEY = 'testNetwork'
const DEFAULT_SWITCH_IP = '10.42.44.12'
const DEFAULT_VLAN = 1
// One hue per VLAN, in VID order — the tree's category hues; VLAN 1 is grey.
const HUES = ['#3d6fa8', '#2e8f66', '#b07a2e', '#7a5cb0', '#a8578c', '#3a8fb0']

interface Lane {
  vid: number
  name: string
  color: string
  /** Bench devices whose port is untagged here. */
  devices: BenchDevice[]
  /** Bench devices whose port carries this VLAN tagged (a trunk, the Pi). */
  trunks: BenchDevice[]
  /** Member ports nobody in the bench table sits on. */
  empty: number[]
}

/** The scan with moves still on their way to the switch already applied, so
 *  a dropped card stays where it was dropped while the switch catches up. */
function withMoves(scan: TestScan, moving: Map<string, number>): TestScan {
  if (!moving.size) return scan
  const ports = new Map([...moving].flatMap(([id, vid]) => {
    const d = scan.bench.find((b) => b.id === id)
    return d ? [[Number(d.port), vid] as const] : []
  }))
  const vlans = scan.switch.vlans.map((v) => ({
    ...v,
    untagged: [...v.untagged.filter((p) => !ports.has(p)),
      ...[...ports].filter(([, vid]) => vid === v.vid).map(([p]) => p)].sort((a, b) => a - b),
  }))
  return { ...scan, switch: { ...scan.switch, vlans } }
}

function buildLanes(scan: TestScan): Lane[] {
  const byPort = new Map(scan.bench.map((d) => [Number(d.port), d]))
  let hue = 0
  const lanes = scan.switch.vlans.map((v): Lane => {
    return {
      vid: v.vid,
      name: v.name,
      color: v.vid === DEFAULT_VLAN ? 'var(--ghost)' : HUES[hue++ % HUES.length],
      devices: v.untagged.flatMap((p) => byPort.get(p) ?? []),
      trunks: v.tagged.flatMap((p) => byPort.get(p) ?? []),
      empty: v.untagged.filter((p) => !byPort.has(p)),
    }
  })
  // Test VLANs first, the default VLAN (where idle ports park) last.
  return [...lanes.filter((l) => l.vid !== DEFAULT_VLAN), ...lanes.filter((l) => l.vid === DEFAULT_VLAN)]
}

export function TestNetworkView({ active }: { active: boolean }) {
  const [switchIp, setSwitchIp] = useState(() =>
    setting<{ switchIp?: string }>(SETTINGS_KEY, {}).switchIp?.trim() || DEFAULT_SWITCH_IP)
  // What the field holds while typing vs the address in use.
  const [savedIp, setSavedIp] = useState(switchIp)
  const [editingIp, setEditingIp] = useState(false)
  const [scan, setScan] = useState<TestScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hoverPort, setHoverPort] = useState<number | null>(null)
  const [picking, setPicking] = useState<BenchDevice | null>(null)
  const [benchOpen, setBenchOpen] = useState(false)
  // Drag and drop: the card in hand, the lane under it, and drops the
  // switch hasn't confirmed yet (device id → VLAN).
  const [dragging, setDragging] = useState<BenchDevice | null>(null)
  const [dropVid, setDropVid] = useState<number | null>(null)
  const [moving, setMoving] = useState<Map<string, number>>(new Map())
  const jobs = useJobs()

  const refresh = useCallback(async (ip: string = savedIp) => {
    setScanning(true)
    setError(null)
    try {
      setScan(await scanTestNetwork(ip))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setScanning(false)
    }
  }, [savedIp])

  // First open reads what the backend last saw, scanning if it saw nothing;
  // a scan from anywhere (an upload landing) is announced and re-read.
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!active || loaded) return
    setLoaded(true)
    fetchTestNetwork().then(
      (state) => (state.scan ? setScan(state.scan) : void refresh()),
      (err) => setError(errorMessage(err)),
    )
  }, [active, loaded, refresh])
  useEffect(() => onEvent('test-network', () => {
    fetchTestNetwork().then((state) => state.scan && setScan(state.scan), () => {})
  }), [])

  const states = useMemo(() => new Map((scan?.devices ?? []).map((d) => [d.id, d])), [scan])
  const shown = useMemo(() => (scan ? withMoves(scan, moving) : null), [scan, moving])
  const lanes = useMemo(() => (shown ? buildLanes(shown) : []), [shown])
  const portColor = useMemo(() => {
    const colors = new Map<number, string>()
    for (const lane of lanes) {
      for (const v of shown?.switch.vlans ?? []) {
        if (v.vid === lane.vid) v.untagged.forEach((p) => colors.set(p, lane.color))
      }
    }
    return colors
  }, [lanes, shown])
  const uploading = useMemo(() => new Map(jobs
    .filter((j) => j.meta?.type === 'test-upload' && j.status === 'running')
    .map((j) => [String(j.meta!.device), String(j.meta!.project)])), [jobs])

  const move = async (device: BenchDevice, vid: number) => {
    setMoving((current) => new Map(current).set(device.id, vid))
    setError(null)
    try {
      setScan((await moveTestDevice({ switchIp: savedIp, device: device.id, vid })).scan)
    } catch (err) {
      setError(`${device.id} → VLAN ${vid}: ${errorMessage(err)}`)
    } finally {
      setMoving((current) => {
        const next = new Map(current)
        next.delete(device.id)
        return next
      })
    }
  }

  // Leaving the switch IP field (Enter or click away) keeps what was typed,
  // remembers it, and reads the network there; an emptied field goes back.
  const commitIp = () => {
    setEditingIp(false)
    const ip = switchIp.trim()
    setSwitchIp(ip || savedIp)
    if (!ip || ip === savedIp) return
    setSavedIp(ip)
    saveSettings({ [SETTINGS_KEY]: { switchIp: ip } }).catch(() => {})
    refresh(ip)
  }

  const upload = async (device: BenchDevice, project: string) => {
    setPicking(null)
    try {
      await uploadToTestRtac({ device: device.id, project, switchIp: savedIp })
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <main className="preview testnet">
      <header className="preview-header testnet-head">
        <div className="preview-title-row">
          <h2>Test network</h2>
          <span className="testnet-switch">
            {editingIp ? (
              <TextInput autoFocus className="ui-input testnet-ip" value={switchIp}
                onChange={(e) => setSwitchIp(e.target.value)}
                onBlur={commitIp}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }} />
            ) : (
              <button className="testnet-ip-value mono" title="Change" onClick={() => setEditingIp(true)}>
                {switchIp}
              </button>
            )}
          </span>
          <span className="testnet-spacer" />
          {scan && <span className="dim testnet-at">{formatStamp(Date.parse(scan.at))}</span>}
          <Button onClick={() => setBenchOpen(true)}>Bench…</Button>
          <Button disabled={scanning} onClick={() => refresh()}>
            {scanning ? <Spinner /> : 'Refresh'}
          </Button>
        </div>
      </header>

      <div className="testnet-body">
        {error && <div className="tool-error">{error}</div>}
        {scan?.switch.error && <div className="tool-error">Switch: {scan.switch.error}</div>}
        {!scan && !error && <div className="pane-message">{scanning ? 'Reading…' : ''}</div>}

        {scan && !scan.switch.error && (
          <>
            <Faceplate scan={shown!} portColor={portColor} hoverPort={hoverPort} onHover={setHoverPort} />
            <div className="testnet-lanes">
              {lanes.map((lane) => (
                <section key={lane.vid}
                  className={'testnet-lane' + (lane.vid === DEFAULT_VLAN ? ' idle' : '')
                    + (dropVid === lane.vid ? ' drop' : '')}
                  style={{ '--lane': lane.color } as React.CSSProperties}
                  onDragOver={(e) => {
                    if (!dragging || lane.devices.some((x) => x.id === dragging.id)) return
                    e.preventDefault()
                    setDropVid(lane.vid)
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropVid(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDropVid(null)
                    if (dragging && !lane.devices.some((x) => x.id === dragging.id)) move(dragging, lane.vid)
                  }}>
                  <header className="testnet-lane-head">
                    <span className="testnet-vid">VLAN {lane.vid}</span>
                    <span className="testnet-lane-name">{lane.name}</span>
                  </header>
                  <div className="testnet-cards">
                    {lane.devices.map((d) => (
                      <DeviceCard key={d.id} device={d} state={states.get(d.id)}
                        uploading={uploading.get(d.id)}
                        moving={moving.has(d.id)}
                        onDrag={(on) => setDragging(on ? d : null)}
                        hover={hoverPort === Number(d.port)}
                        onHover={(on) => setHoverPort(on ? Number(d.port) : null)}
                        onClick={d.kind === 'rtac' ? () => setPicking(d) : undefined} />
                    ))}
                    {lane.trunks.map((d) => (
                      <div key={`t-${d.id}`} className={hoverPort === Number(d.port) ? 'testnet-trunk hover' : 'testnet-trunk'}
                        onMouseEnter={() => setHoverPort(Number(d.port))}
                        onMouseLeave={() => setHoverPort(null)}>
                        <span className="testnet-trunk-name">{d.id}</span>
                        <span className="dim">port {d.port} · tagged</span>
                      </div>
                    ))}
                    {lane.empty.length > 0 && (
                      <div className="testnet-empty dim">
                        {lane.vid === DEFAULT_VLAN
                          ? `${lane.empty.length} empty ports`
                          : `port ${lane.empty.join(', ')}`}
                      </div>
                    )}
                    {!lane.devices.length && !lane.trunks.length && !lane.empty.length && (
                      <div className="testnet-empty dim">None.</div>
                    )}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>

      {picking && (
        <Modal title={`Upload to ${picking.id}`} onClose={() => setPicking(null)}>
          <div className="testnet-pick">
            <div className="testnet-pick-now">
              <span className="mono">{picking.networkIp}</span>
              {states.get(picking.id)?.project && (
                <span className="dim">{states.get(picking.id)!.project!.name}</span>
              )}
            </div>
            <AcrtacProjectList mode="single" autoFocus
              current={states.get(picking.id)?.project?.name ?? null}
              onPick={(name) => upload(picking, name)} />
          </div>
        </Modal>
      )}

      {benchOpen && (
        <BenchModal onClose={() => setBenchOpen(false)}
          onSaved={() => {
            setBenchOpen(false)
            refresh()
          }} />
      )}
    </main>
  )
}

/** The switch's front: odd ports on top, even below, each tinted by its
 *  untagged VLAN; a tagged port also gets a ring. */
function Faceplate({
  scan,
  portColor,
  hoverPort,
  onHover,
}: {
  scan: TestScan
  portColor: Map<number, string>
  hoverPort: number | null
  onHover: (port: number | null) => void
}) {
  const byPort = new Map(scan.bench.map((d) => [Number(d.port), d]))
  const tagged = new Set(scan.switch.vlans.flatMap((v) => v.tagged))
  const ports = scan.switch.ports
  const rows = [ports.filter((p) => p % 2 === 1), ports.filter((p) => p % 2 === 0)]
  return (
    <div className="testnet-faceplate">
      {rows.map((row, i) => (
        <div key={i} className="testnet-portrow">
          {row.map((p) => {
            const device = byPort.get(p)
            return (
              <div key={p}
                className={'testnet-port' + (device ? ' used' : '') + (tagged.has(p) ? ' tagged' : '')
                  + (hoverPort === p ? ' hover' : '')}
                style={{ '--port': portColor.get(p) ?? 'var(--border)' } as React.CSSProperties}
                title={device ? `${device.id} · port ${p}` : `port ${p}`}
                onMouseEnter={() => onHover(p)}
                onMouseLeave={() => onHover(null)}>
                <span className="testnet-port-n">{p}</span>
                {device && <span className="testnet-port-dev">{device.id}</span>}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function DeviceCard({
  device,
  state,
  uploading,
  moving,
  onDrag,
  hover,
  onHover,
  onClick,
}: {
  device: BenchDevice
  state: TestDeviceState | undefined
  uploading: string | undefined
  moving: boolean
  onDrag: (on: boolean) => void
  hover: boolean
  onHover: (on: boolean) => void
  onClick?: () => void
}) {
  const rtac = device.kind === 'rtac'
  const status = !rtac ? null : uploading || moving ? 'busy' : state?.error ? 'bad'
    : state?.project?.state === 'running' ? 'ok' : 'warn'
  return (
    <div
      className={'testnet-card' + (rtac ? ' rtac' : '') + (hover ? ' hover' : '') + (moving ? ' moving' : '')}
      draggable={!moving}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', device.id)
        onDrag(true)
      }}
      onDragEnd={() => onDrag(false)}
      onClick={onClick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      title={state?.error ?? undefined}>
      <div className="testnet-card-top">
        <span className="testnet-card-name">{device.id}</span>
        <span className="dim">port {device.port}</span>
      </div>
      {rtac ? (
        <>
          <div className="testnet-card-ip mono" title={state?.eth02 ? `Eth_02 ${state.eth02} via ${state.gateway ?? '—'}` : undefined}>
            {state?.eth02?.split('/')[0] ?? '—'}
          </div>
          <div className="testnet-card-net mono dim">{device.networkIp}</div>
          <div className="testnet-card-proj">
            <span className={`testnet-dot ${status}`} />
            {uploading ? (
              <span className="testnet-proj-name">→ {uploading}</span>
            ) : state?.error ? (
              <span className="testnet-proj-name bad">Unreachable</span>
            ) : state?.project ? (
              <span className="testnet-proj-name" title={state.project.state}>{state.project.name}</span>
            ) : (
              <span className="testnet-proj-name dim">No project</span>
            )}
          </div>
        </>
      ) : (
        <div className="testnet-card-net mono dim">{device.networkIp || ' '}</div>
      )}
    </div>
  )
}

// --- the bench device table ---------------------------------------------------

type DraftDevice = BenchDevice & { key: number }

const blank = (key: number): DraftDevice => ({ id: '', kind: 'rtac', networkIp: '', port: '', key })

/** The table is read fresh on open, never from a scan — saving is a
 *  whole-table replace, and a scan that failed has no table to hand over. */
function BenchModal({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (devices: BenchDevice[]) => void
}) {
  const [nextKey, setNextKey] = useState(1000)
  const [draft, setDraft] = useState<DraftDevice[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { run, busy, error } = useAction()
  useEffect(() => {
    fetchBenchDevices().then(
      (devices) => setDraft(devices.length ? devices.map((d, i) => ({ ...d, key: i })) : [blank(0)]),
      (err) => setLoadError(errorMessage(err)),
    )
  }, [])

  const set = (key: number, patch: Partial<BenchDevice>) =>
    setDraft((current) => current && current.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  const save = () => run(async () => {
    if (!draft) return
    const rows = draft
      .filter((d) => d.id.trim() || d.networkIp.trim() || d.port.trim())
      .map(({ id, kind, networkIp, port }) => ({ id, kind, networkIp, port }))
    onSaved(await saveBenchDevices(rows))
  })

  return (
    <Modal title="Bench devices" onClose={onClose} locked={busy} className="testnet-bench-modal">
      {loadError && <div className="modal-error">{loadError}</div>}
      {draft && (<>
      <div className="testnet-bench">
        <span className="testnet-col">Identifier</span>
        <span className="testnet-col">Kind</span>
        <span className="testnet-col">Network IP</span>
        <span className="testnet-col">Port</span>
        <span />
        {draft.map((d) => (
          <Fragment key={d.key}>
            <TextInput value={d.id} onChange={(e) => set(d.key, { id: e.target.value })} />
            <Select value={d.kind} options={[{ value: 'rtac', label: 'RTAC' }, { value: 'other', label: 'Other' }]}
              onChange={(kind) => set(d.key, { kind: kind as BenchDevice['kind'] })} />
            <TextInput value={d.networkIp} onChange={(e) => set(d.key, { networkIp: e.target.value })} />
            <TextInput value={d.port} onChange={(e) => set(d.key, { port: e.target.value })} />
            <RowAction kind="delete" title="Remove"
              onClick={() => setDraft((current) => current && current.filter((x) => x.key !== d.key))} />
          </Fragment>
        ))}
      </div>
      <div className="testnet-bench-foot">
        <Button onClick={() => {
          setDraft((current) => current && [...current, blank(nextKey)])
          setNextKey((k) => k + 1)
        }}>+ Add</Button>
        <span className="testnet-spacer" />
        {error && <span className="tool-error">{error}</span>}
        <Button variant="primary" onClick={save} disabled={busy}>Save</Button>
      </div>
      </>)}
    </Modal>
  )
}
