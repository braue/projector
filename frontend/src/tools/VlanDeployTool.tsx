// RTAC VLAN Deploy — bring a bench of RTACs onto one VLAN and load their
// projects. For the run: one switch, one VLAN ID, and the switch port the
// Raspberry Pi (network translation for testing) sits on. Per RTAC: a bench
// device picked by identifier (its network IP and switch port come from the
// bench device table, edited on this tool's second page), the VLAN IP its
// Eth_02 gets (always /24, gateway .1), and its AcRTAC project. The backend
// runs it as one job: Eth_02 IPs → the VLAN becomes exactly these ports →
// uploads, several at a time. A failed RTAC in the first two stages stops the
// run before the next; re-running skips whatever is already done.

import { Fragment, useEffect, useRef, useState } from 'react'

import {
  fetchBenchDevices,
  fetchToolSettings,
  saveBenchDevices,
  startVlanDeployJob,
  updateToolSettings,
  type BenchDevice,
  type VlanDeployRtac,
} from '../api'
import { AcrtacProjectPicker } from '../components/AcrtacProjectPicker'
import { Button, SectionHeader, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { count } from '../lib/format'
import { useAction } from '../lib/useAction'
import { useToolJob } from '../lib/useToolJob'
import type { ToolProps } from './registry'

interface StepResult {
  ok: boolean
  error?: string
  before?: string
  after?: string
  gateway?: string
  changed?: boolean
  attempts?: number
}

interface DeployOutcome {
  rtacs: { label: string; networkIp: string; project: string; ip: StepResult | null; upload: StepResult | null }[]
  vlan: (StepResult & { moved?: Record<string, string>; removed?: string; tagged?: string }) | null
  stoppedAt: null | 'ip' | 'vlan'
}

/** The run-wide fields, remembered in tool settings between launches. */
interface RunFields {
  switchIp: string
  vlan: string
  piPort: string
}

const SETTINGS_KEY = 'vlanDeploy'
// The bench switch. Locked in the form behind an Edit button, since it is
// almost never anything else.
const DEFAULT_SWITCH_IP = '10.42.44.12'
const emptyRow = (): VlanDeployRtac => ({ device: '', vlanIp: '', project: '' })

function Step({ step, done }: { step: StepResult | null; done: string }) {
  if (!step) return <span className="tool-stats">—</span>
  if (!step.ok) return <span className="vlandeploy-bad" title={step.error}>✕ {step.error}</span>
  return <span className="vlandeploy-ok">✓ {done}</span>
}

export function VlanDeployTool({ active }: ToolProps) {
  const [page, setPage] = useState<'deploy' | 'devices'>('deploy')
  const [error, setError] = useState<string | null>(null)

  const [devices, setDevices] = useState<BenchDevice[] | null>(null)
  const [picking, setPicking] = useState<number | null>(null)

  const [fields, setFields] = useState<RunFields>({ switchIp: DEFAULT_SWITCH_IP, vlan: '', piPort: '' })
  const [editingSwitch, setEditingSwitch] = useState(false)
  const switchInput = useRef<HTMLInputElement>(null)
  // Unlocking hands the keyboard straight to the field, IP selected to type over.
  useEffect(() => {
    if (!editingSwitch) return
    switchInput.current?.focus()
    switchInput.current?.select()
  }, [editingSwitch])
  const [rows, setRows] = useState<VlanDeployRtac[]>([emptyRow()])

  const [outcome, setOutcome] = useState<DeployOutcome | null>(null)
  const { job, running, start } = useToolJob(
    (result) => setOutcome(result as DeployOutcome),
    setError,
  )

  // The device table and last run's fields load when the tool is first
  // shown; the project picker reads the shared AcRTAC list when opened.
  useEffect(() => {
    if (!active || devices !== null) return
    fetchBenchDevices().then(setDevices, (err) => { setDevices([]); setError(errorMessage(err)) })
    fetchToolSettings().then((settings) => {
      const saved = settings[SETTINGS_KEY] as Partial<RunFields> | undefined
      if (saved) {
        setFields((current) => ({
          switchIp: saved.switchIp?.trim() || DEFAULT_SWITCH_IP,
          vlan: saved.vlan ?? current.vlan,
          piPort: saved.piPort ?? current.piPort,
        }))
      }
    }, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const setField = <K extends keyof RunFields>(key: K, value: RunFields[K]) =>
    setFields((current) => ({ ...current, [key]: value }))
  const setRow = (index: number, patch: Partial<VlanDeployRtac>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const byId = new Map((devices ?? []).map((d) => [d.id, d]))
  const ready = fields.switchIp.trim() && fields.vlan.trim() && fields.piPort.trim() &&
    rows.every((r) => byId.has(r.device) && r.vlanIp.trim() && r.project)

  const deploy = async () => {
    setError(null)
    setOutcome(null)
    try {
      const { job: id } = await startVlanDeployJob({ ...fields, rtacs: rows })
      start(id)
      updateToolSettings({ [SETTINGS_KEY]: fields }).catch(() => {})
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  if (page === 'devices') {
    return (
      <BenchDevicesPage
        devices={devices ?? []}
        onSaved={(saved) => {
          setDevices(saved)
          // a renamed/removed device can't stay picked
          const ids = new Set(saved.map((d) => d.id))
          setRows((current) => current.map((r) => (ids.has(r.device) ? r : { ...r, device: '' })))
          setPage('deploy')
        }}
        onBack={() => setPage('deploy')}
      />
    )
  }

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>RTAC VLAN Deploy</h2>
          {running && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <div className="tool-row">
          <div className="vlandeploy-switch">
            <TextInput ref={switchInput} label="Switch IP" value={fields.switchIp} readOnly={!editingSwitch}
              className={editingSwitch ? 'ui-input' : 'ui-input vlandeploy-locked'}
              onChange={(e) => setField('switchIp', e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setEditingSwitch(false)
              }} />
            <Button title={editingSwitch ? 'Lock the switch IP' : 'Change the switch IP'}
              onClick={() => {
                if (editingSwitch && !fields.switchIp.trim()) setField('switchIp', DEFAULT_SWITCH_IP)
                setEditingSwitch((value) => !value)
              }}>
              {editingSwitch ? 'Done' : 'Edit'}
            </Button>
          </div>
          <TextInput label="VLAN ID" value={fields.vlan}
            onChange={(e) => setField('vlan', e.target.value)} />
          <TextInput label="Raspberry Pi port" value={fields.piPort}
            onChange={(e) => setField('piPort', e.target.value)} />
        </div>

        <div className="tool-row vlandeploy-head">
          <SectionHeader title="RTACs" count={rows.length} />
          <Button onClick={() => setPage('devices')}>Bench devices…</Button>
        </div>
        {devices?.length === 0 && (
          <div className="tool-empty">
            No bench devices yet — add each device’s identifier, network IP and switch port under
            Bench devices.
          </div>
        )}
        <div className="vlandeploy-grid">
          <span className="vlandeploy-col">Device</span>
          <span className="vlandeploy-col">Network IP · port</span>
          <span className="vlandeploy-col">VLAN IP (/24)</span>
          <span className="vlandeploy-col">Project</span>
          <span />
          {rows.map((row, index) => {
            const device = byId.get(row.device)
            const usedElsewhere = new Set(rows.filter((_, i) => i !== index).map((r) => r.device))
            return (
              <Fragment key={index}>
                <Select value={row.device} placeholder="Pick a device…"
                  options={(devices ?? []).filter((d) => !usedElsewhere.has(d.id)).map((d) => d.id)}
                  disabled={!devices?.length}
                  onChange={(id) => setRow(index, { device: id })} />
                <span className="tool-stats">
                  {device ? `${device.networkIp} · port ${device.port}` : '—'}
                </span>
                <TextInput value={row.vlanIp} placeholder="192.168.xxx.xxx"
                  onChange={(e) => setRow(index, { vlanIp: e.target.value })} />
                <button className="vlandeploy-project" title={row.project || 'Pick the AcRTAC project'}
                  onClick={() => setPicking(index)}>
                  {row.project || <span className="vlandeploy-ghost">Pick a project…</span>}
                </button>
                <Button title="Remove this RTAC" disabled={rows.length === 1}
                  onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
                  ✕
                </Button>
              </Fragment>
            )
          })}
        </div>
        <div className="tool-row">
          <Button onClick={() => setRows((current) => [...current, emptyRow()])}
            disabled={!!devices && rows.length >= devices.length}>
            + Add RTAC
          </Button>
          <Button variant="primary" disabled={!ready || running} onClick={deploy}>
            Deploy {count(rows.length, 'RTAC')}
          </Button>
        </div>

        {error && <div className="tool-error">{error}</div>}

        {job && (running || job.status === 'error') && (
          <div className="tool-joblog">
            {job.log.map((line, i) => (
              <div key={i} className="tool-joblog-line">{line}</div>
            ))}
          </div>
        )}

        {outcome && (
          <>
            {outcome.stoppedAt && (
              <div className="tool-error">
                Stopped after the {outcome.stoppedAt === 'ip' ? 'Eth_02 step' : 'switch step'} —
                fix what failed and deploy again; finished steps are skipped.
              </div>
            )}
            {outcome.vlan && (
              <div className="tool-stats">
                Switch: <Step step={outcome.vlan}
                  done={outcome.vlan.changed
                    ? `VLAN ${fields.vlan} = ${outcome.vlan.after}` +
                      (outcome.vlan.removed ? ` (${outcome.vlan.removed} moved to VLAN 1)` : '') +
                      (outcome.vlan.tagged ? ` (tagged ${outcome.vlan.tagged} removed)` : '')
                    : `VLAN ${fields.vlan} already exactly ${outcome.vlan.after}`} />
              </div>
            )}
            <div className="vlandeploy-results">
              <span className="vlandeploy-col">RTAC</span>
              <span className="vlandeploy-col">Eth_02</span>
              <span className="vlandeploy-col">Upload</span>
              {outcome.rtacs.map((r) => (
                <Fragment key={r.label}>
                  <span>{r.label} <span className="tool-stats">{r.project}</span></span>
                  <Step step={r.ip}
                    done={r.ip?.changed
                      ? `${r.ip.before} → ${r.ip.after} via ${r.ip.gateway}`
                      : `already ${r.ip?.after} via ${r.ip?.gateway}`} />
                  <Step step={r.upload}
                    done={r.upload?.attempts && r.upload.attempts > 1 ? `sent (attempt ${r.upload.attempts})` : 'sent'} />
                </Fragment>
              ))}
            </div>
          </>
        )}
      </div>

      {picking !== null && (
        <AcrtacProjectPicker
          current={rows[picking]?.project}
          taken={rows.filter((_, i) => i !== picking).map((r) => r.project).filter(Boolean)}
          onPick={(project) => {
            setRow(picking, { project })
            setPicking(null)
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  )
}

// --- the bench device table ---------------------------------------------------

type DraftDevice = BenchDevice & { key: number }

/** The second page: edit which identifier sits at which network IP on which
 *  switch port. Saved whole; the backend refuses bad or repeated values. */
function BenchDevicesPage({
  devices,
  onSaved,
  onBack,
}: {
  devices: BenchDevice[]
  onSaved: (devices: BenchDevice[]) => void
  onBack: () => void
}) {
  const [nextKey, setNextKey] = useState(devices.length + 1)
  const [draft, setDraft] = useState<DraftDevice[]>(() =>
    devices.length ? devices.map((d, i) => ({ ...d, key: i })) : [{ id: '', networkIp: '', port: '', key: 0 }])
  const { run, busy: saving, error } = useAction()

  const set = (key: number, patch: Partial<BenchDevice>) =>
    setDraft((current) => current.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  const add = () => {
    setDraft((current) => [...current, { id: '', networkIp: '', port: '', key: nextKey }])
    setNextKey((k) => k + 1)
  }

  const save = () => run(async () => {
    // rows left entirely blank are just unused space, not errors
    const rows = draft
      .filter((d) => d.id.trim() || d.networkIp.trim() || d.port.trim())
      .map(({ id, networkIp, port }) => ({ id, networkIp, port }))
    onSaved(await saveBenchDevices(rows))
  })

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>Bench devices</h2>
          {saving && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <div className="vlandeploy-devices">
          <span className="vlandeploy-col">Identifier</span>
          <span className="vlandeploy-col">Network IP</span>
          <span className="vlandeploy-col">Switch port</span>
          <span />
          {draft.map((d) => (
            <Fragment key={d.key}>
              <TextInput value={d.id} onChange={(e) => set(d.key, { id: e.target.value })} />
              <TextInput value={d.networkIp}
                onChange={(e) => set(d.key, { networkIp: e.target.value })} />
              <TextInput value={d.port} onChange={(e) => set(d.key, { port: e.target.value })} />
              <Button title="Remove this device"
                onClick={() => setDraft((current) => current.filter((x) => x.key !== d.key))}>
                ✕
              </Button>
            </Fragment>
          ))}
        </div>
        <div className="tool-row">
          <Button onClick={add}>+ Add device</Button>
          <Button onClick={onBack} disabled={saving}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving}>Save</Button>
        </div>
        {error && <div className="tool-error">{error}</div>}
      </div>
    </>
  )
}
