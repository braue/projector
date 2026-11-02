// The Test pane — the bench network as it stands. The SEL-2730M's VLAN table
// says which port is on which VLAN; the bench device table says who is on
// that port; each RTAC's web interface says its Eth_02 address and running
// project. Drawn as the switch's faceplate over one lane per VLAN. Dragging
// a card onto another lane moves its switch port to that VLAN, on the switch,
// at once; Ctrl+click picks several cards to drag together (one switch save).
// A lane's name renames its VLAN on a click, its ✕ deletes it (the switch
// puts its ports back on VLAN 1), and "+ VLAN" adds one. Clicking an RTAC opens its window: a new Eth_02 address, then
// Upload (pick an AcRTAC database project, then send it) or Read (its
// running project into the database, opened in the AcRTAC GUI) — each a job.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  editTestVlan,
  fetchBenchDevices,
  fetchTestNetwork,
  moveTestDevices,
  saveBenchDevices,
  scanTestNetwork,
  setTestEth02,
  readTestRtac,
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
  // Drag and drop: the cards in hand, the lane under them, and drops the
  // switch hasn't confirmed yet (device id → VLAN). Ctrl+click builds a
  // selection that drags as one.
  const [dragging, setDragging] = useState<BenchDevice[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dropVid, setDropVid] = useState<number | null>(null)
  const [moving, setMoving] = useState<Map<string, number>>(new Map())
  // VLAN edits: the lane whose name is being typed, the add window, and the
  // VLANs a delete is on its way to the switch for.
  const [renaming, setRenaming] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<Set<number>>(new Set())
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
  // What each RTAC is doing through AcRTAC right now, as its card says it.
  const activity = useMemo(() => new Map(jobs
    .filter((j) => (j.meta?.type === 'test-upload' || j.meta?.type === 'test-read') && j.status === 'running')
    .map((j) => [String(j.meta!.device), j.meta!.type === 'test-read' ? '← Reading' : `→ ${String(j.meta!.project)}`])), [jobs])

  const move = async (devices: BenchDevice[], vid: number) => {
    const ids = devices.map((d) => d.id)
    setMoving((current) => {
      const next = new Map(current)
      for (const id of ids) next.set(id, vid)
      return next
    })
    setError(null)
    try {
      setScan((await moveTestDevices({ switchIp: savedIp, devices: ids, vid })).scan)
    } catch (err) {
      setError(`${ids.join(', ')} → VLAN ${vid}: ${errorMessage(err)}`)
    } finally {
      setMoving((current) => {
        const next = new Map(current)
        for (const id of ids) next.delete(id)
        return next
      })
    }
  }

  /** One VLAN edit on the switch; the page takes the VLAN table it re-read
   *  (or rescans when the backend has no snapshot to patch). Throws. */
  const editVlan = async (args: { op: 'add' | 'rename' | 'delete'; vid: number; name?: string }) => {
    setError(null)
    const { scan: next } = await editTestVlan({ switchIp: savedIp, ...args })
    if (next) setScan(next)
    else refresh()
  }

  const rename = async (vid: number, name: string) => {
    try {
      await editVlan({ op: 'rename', vid, name })
    } catch (err) {
      setError(`VLAN ${vid}: ${errorMessage(err)}`)
    } finally {
      setRenaming(null)
    }
  }

  const remove = async (lane: Lane) => {
    const what = `VLAN ${lane.vid}${lane.name ? ` "${lane.name}"` : ''}`
    if (!window.confirm(lane.devices.length || lane.empty.length
      ? `Delete ${what}? Its ports go to VLAN ${DEFAULT_VLAN}.`
      : `Delete ${what}?`)) return
    setDeleting((current) => new Set(current).add(lane.vid))
    try {
      await editVlan({ op: 'delete', vid: lane.vid })
    } catch (err) {
      setError(`${what}: ${errorMessage(err)}`)
    } finally {
      setDeleting((current) => {
        const next = new Set(current)
        next.delete(lane.vid)
        return next
      })
    }
  }

  // Esc lets go of the selection.
  useEffect(() => {
    if (!active || !selected.size) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, selected])
  // The cards a drag from `device` carries: the whole selection when the
  // card is in it, else just that card.
  const dragSet = (device: BenchDevice): BenchDevice[] => {
    if (!selected.has(device.id) || selected.size < 2) return [device]
    return lanes.flatMap((lane) => lane.devices).filter((d) => selected.has(d.id) && !moving.has(d.id))
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

  const read = async (device: BenchDevice) => {
    setPicking(null)
    try {
      await readTestRtac({ device: device.id })
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
          <Button disabled={!scan || !!scan.switch.error} onClick={() => setAdding(true)}>+ VLAN</Button>
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
                    + (dropVid === lane.vid ? ' drop' : '') + (deleting.has(lane.vid) ? ' deleting' : '')}
                  style={{ '--lane': lane.color } as React.CSSProperties}
                  onDragOver={(e) => {
                    const arriving = (dragging ?? []).filter((d) => !lane.devices.some((x) => x.id === d.id))
                    if (!arriving.length) return
                    e.preventDefault()
                    setDropVid(lane.vid)
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropVid(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDropVid(null)
                    const arriving = (dragging ?? []).filter((d) => !lane.devices.some((x) => x.id === d.id))
                    if (!arriving.length) return
                    setSelected(new Set())
                    move(arriving, lane.vid)
                  }}>
                  <header className="testnet-lane-head">
                    <span className="testnet-vid">VLAN {lane.vid}</span>
                    {renaming === lane.vid ? (
                      <LaneNameInput initial={lane.name}
                        onCommit={(name) => rename(lane.vid, name)}
                        onCancel={() => setRenaming(null)} />
                    ) : (
                      <button className="testnet-lane-name" title="Rename"
                        disabled={deleting.has(lane.vid)}
                        onClick={() => setRenaming(lane.vid)}>
                        {lane.name || '—'}
                      </button>
                    )}
                    {lane.vid !== DEFAULT_VLAN && !deleting.has(lane.vid) && (
                      <RowAction kind="delete" title="Delete" onClick={() => remove(lane)} />
                    )}
                    {deleting.has(lane.vid) && <Spinner />}
                  </header>
                  <div className="testnet-cards">
                    {lane.devices.map((d) => (
                      <DeviceCard key={d.id} device={d} state={states.get(d.id)}
                        activity={activity.get(d.id)}
                        moving={moving.has(d.id)}
                        selected={selected.has(d.id)}
                        onDragStart={() => {
                          const set = dragSet(d)
                          if (set.length === 1) setSelected(new Set())
                          setDragging(set)
                          return set.length
                        }}
                        onDragEnd={() => setDragging(null)}
                        hover={hoverPort === Number(d.port)}
                        onHover={(on) => setHoverPort(on ? Number(d.port) : null)}
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey) {
                            setSelected((current) => {
                              const next = new Set(current)
                              if (next.has(d.id)) next.delete(d.id)
                              else next.add(d.id)
                              return next
                            })
                            return
                          }
                          setSelected(new Set())
                          if (d.kind === 'rtac') setPicking(d)
                        }} />
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
        <RtacModal device={picking} state={states.get(picking.id)}
          onClose={() => setPicking(null)}
          onEth02={async (ip) => setScan((await setTestEth02({ device: picking.id, ip })).scan)}
          onUpload={(name) => upload(picking, name)}
          onRead={() => read(picking)} />
      )}

      {adding && scan && (
        <AddVlanModal taken={scan.switch.vlans.map((v) => v.vid)}
          onClose={() => setAdding(false)}
          onAdd={async (vid, name) => {
            await editVlan({ op: 'add', vid, name })
            setAdding(false)
          }} />
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

/** A lane's name, being typed: Enter or clicking away saves a changed name,
 *  Esc (or an unchanged / emptied one) leaves it. */
function LaneNameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [pending, setPending] = useState(false)
  // Set once Esc or a commit has finished the field, so the blur that
  // follows can't act a second time.
  const done = useRef(false)
  const finish = () => {
    if (done.current) return
    done.current = true
    const name = value.trim()
    if (!name || name === initial) return onCancel()
    setPending(true)
    onCommit(name)
  }
  return (
    <span className="testnet-lane-rename">
      <TextInput autoFocus value={value} maxLength={128} spellCheck={false} disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            done.current = true
            onCancel()
          }
        }} />
      {pending && <Spinner />}
    </span>
  )
}

/** A new VLAN: its ID (the next free one above the highest, to start) and
 *  name. It starts with no ports — drag cards onto it. */
function AddVlanModal({
  taken,
  onClose,
  onAdd,
}: {
  taken: number[]
  onClose: () => void
  onAdd: (vid: number, name: string) => Promise<void>
}) {
  const [vid, setVid] = useState(() => String(Math.min(4094, Math.max(1, ...taken) + 1)))
  const [name, setName] = useState('')
  const { run, busy, error } = useAction()
  const n = Number(vid.trim())
  const valid = Number.isInteger(n) && n >= 1 && n <= 4094 && !taken.includes(n) && name.trim() !== ''
  const add = () => valid && !busy && run(() => onAdd(n, name.trim()))
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') add()
  }
  return (
    <Modal title="New VLAN" onClose={onClose} locked={busy}>
      <div className="testnet-addvlan">
        <TextInput label="VLAN" value={vid} disabled={busy} className="ui-input testnet-addvlan-vid"
          onChange={(e) => setVid(e.target.value)} onKeyDown={enter} />
        <TextInput label="Name" value={name} autoFocus maxLength={128} disabled={busy}
          onChange={(e) => setName(e.target.value)} onKeyDown={enter} />
        {taken.includes(n) && <div className="modal-error">VLAN {n} exists.</div>}
        {error && <div className="modal-error">{error}</div>}
        <div className="testnet-upload-bar">
          <Button variant="primary" disabled={!valid || busy} onClick={add}>{busy ? <Spinner /> : 'Add'}</Button>
        </div>
      </div>
    </Modal>
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
  activity,
  moving,
  selected,
  onDragStart,
  onDragEnd,
  hover,
  onHover,
  onClick,
}: {
  device: BenchDevice
  state: TestDeviceState | undefined
  /** An AcRTAC job in flight on it: "→ Project" or "← Reading". */
  activity: string | undefined
  moving: boolean
  selected: boolean
  /** Returns how many cards the drag carries. */
  onDragStart: () => number
  onDragEnd: () => void
  hover: boolean
  onHover: (on: boolean) => void
  onClick: (e: React.MouseEvent) => void
}) {
  const rtac = device.kind === 'rtac'
  const status = !rtac ? null : activity || moving ? 'busy' : state?.error ? 'bad'
    : state?.project?.state === 'running' ? 'ok' : 'warn'
  return (
    <div
      className={'testnet-card' + (rtac ? ' rtac' : '') + (hover ? ' hover' : '') + (moving ? ' moving' : '')
        + (selected ? ' selected' : '')}
      draggable={!moving}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', device.id)
        const count = onDragStart()
        if (count > 1) {
          // One ghost for the group: "5 devices".
          const ghost = document.createElement('div')
          ghost.className = 'testnet-ghost'
          ghost.textContent = `${count} devices`
          document.body.appendChild(ghost)
          e.dataTransfer.setDragImage(ghost, 12, 12)
          setTimeout(() => ghost.remove(), 0)
        }
      }}
      onDragEnd={onDragEnd}
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
            {activity ? (
              <span className="testnet-proj-name">{activity}</span>
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

/** An RTAC's window: its Eth_02 address, editable, then its two AcRTAC
 *  actions. Upload opens the database picker; a project is only sent once
 *  it is selected AND "Upload project" is pressed. Read starts at once. */
function RtacModal({
  device,
  state,
  onClose,
  onEth02,
  onUpload,
  onRead,
}: {
  device: BenchDevice
  state: TestDeviceState | undefined
  onClose: () => void
  onEth02: (ip: string) => Promise<void>
  onUpload: (project: string) => void
  onRead: () => void
}) {
  const current = state?.eth02?.split('/')[0] ?? ''
  const [ip, setIp] = useState(current)
  const [picking, setPicking] = useState(false)
  const [chosen, setChosen] = useState<string | null>(null)
  const { run, busy, error } = useAction()
  const save = () => run(() => onEth02(ip.trim()))
  const changed = ip.trim() !== '' && ip.trim() !== current

  return (
    <Modal title={device.id} onClose={onClose} locked={busy}>
      <div className="testnet-pick">
        <div className="testnet-pick-now">
          <span className="mono">{device.networkIp}</span>
          {state?.project && <span className="dim">{state.project.name}</span>}
        </div>
        <div className="testnet-eth02">
          <TextInput label="Eth_02" value={ip} spellCheck={false} disabled={busy}
            onChange={(e) => setIp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && changed && !busy) save()
            }} />
          <span className="mono dim">/24</span>
          <Button disabled={!changed || busy} onClick={save}>{busy ? <Spinner /> : 'Set'}</Button>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="testnet-actions">
          <Button className={picking ? 'on' : undefined} onClick={() => setPicking(!picking)}>Upload</Button>
          <Button onClick={onRead}>Read</Button>
        </div>
        {picking && (
          <>
            <AcrtacProjectList mode="single" autoFocus
              current={state?.project?.name ?? null}
              selected={chosen}
              onPick={setChosen} />
            <div className="testnet-upload-bar">
              <Button variant="primary" disabled={!chosen} onClick={() => chosen && onUpload(chosen)}>
                Upload project
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
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
