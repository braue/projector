// RTAC VLAN Deploy — bring a bench of RTACs onto one VLAN and load their
// projects. Per RTAC: the network IP it's reached at, the VLAN IP/mask its
// Eth_02 gets, the switch port it's plugged into, and its AcRTAC project. One
// switch and one VLAN ID for the run. The backend runs it as one job:
// Eth_02 IPs → switch ports onto the VLAN → uploads one at a time over the
// network IP. A failed RTAC in the first two stages stops the run before the
// next; re-running skips whatever is already done.

import { Fragment, useEffect, useState } from 'react'

import { listRtacExportProjects, startVlanDeployJob, type VlanDeployRtac } from '../api'
import { Button, SectionHeader, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { count } from '../lib/format'
import { useToolJob } from '../lib/useToolJob'
import type { ToolProps } from './registry'

interface StepResult {
  ok: boolean
  error?: string
  before?: string
  after?: string
  changed?: boolean
}

interface DeployOutcome {
  rtacs: { networkIp: string; project: string; ip: StepResult | null; upload: StepResult | null }[]
  vlan: (StepResult & { moved?: Record<string, string> }) | null
  stoppedAt: null | 'ip' | 'vlan'
}

const emptyRow = (): VlanDeployRtac => ({ networkIp: '', vlanIp: '', port: '', project: '' })

function Step({ step, done }: { step: StepResult | null; done: string }) {
  if (!step) return <span className="tool-stats">—</span>
  if (!step.ok) return <span className="vlandeploy-bad" title={step.error}>✕ {step.error}</span>
  return <span className="vlandeploy-ok">✓ {done}</span>
}

export function VlanDeployTool({ active }: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)

  const [switchIp, setSwitchIp] = useState('')
  const [vlan, setVlan] = useState('')
  const [rows, setRows] = useState<VlanDeployRtac[]>([emptyRow()])

  const [outcome, setOutcome] = useState<DeployOutcome | null>(null)
  const { job, running, start } = useToolJob(
    (result) => setOutcome(result as DeployOutcome),
    setError,
  )

  const loadProjects = async () => {
    setLoading(true)
    setError(null)
    try {
      setProjects(await listRtacExportProjects())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  // The list comes from the AcRTAC database (a Python session), so fetch it
  // when the tool is first shown, not at app start.
  useEffect(() => {
    if (active && projects === null && !loading && !error) loadProjects()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const setRow = (index: number, patch: Partial<VlanDeployRtac>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const ready = switchIp.trim() && vlan.trim() && rows.every((r) =>
    r.networkIp.trim() && r.vlanIp.trim() && r.port.trim() && r.project)

  const deploy = async () => {
    setError(null)
    setOutcome(null)
    try {
      const { job: id } = await startVlanDeployJob({ switchIp, vlan, rtacs: rows })
      start(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>RTAC VLAN Deploy</h2>
          {(loading || running) && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <div className="tool-row">
          <TextInput label="Switch IP" value={switchIp} placeholder="10.42.44.12"
            onChange={(e) => setSwitchIp(e.target.value)} />
          <TextInput label="VLAN ID" value={vlan} placeholder="14"
            onChange={(e) => setVlan(e.target.value)} />
        </div>

        <SectionHeader title="RTACs" count={rows.length} />
        <div className="vlandeploy-grid">
          <span className="vlandeploy-col">Network IP</span>
          <span className="vlandeploy-col">VLAN IP / mask</span>
          <span className="vlandeploy-col">Switch port</span>
          <span className="vlandeploy-col">Project</span>
          <span />
          {rows.map((row, index) => (
            <Fragment key={index}>
              <TextInput value={row.networkIp} placeholder="10.42.44.34"
                onChange={(e) => setRow(index, { networkIp: e.target.value })} />
              <TextInput value={row.vlanIp} placeholder="172.16.100.200/24"
                onChange={(e) => setRow(index, { vlanIp: e.target.value })} />
              <TextInput value={row.port} placeholder="3"
                onChange={(e) => setRow(index, { port: e.target.value })} />
              <Select value={row.project} placeholder={projects ? 'Pick a project…' : loading ? 'Loading…' : 'No projects loaded'}
                options={projects ?? []} disabled={!projects}
                onChange={(project) => setRow(index, { project })} />
              <Button title="Remove this RTAC" disabled={rows.length === 1}
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}>
                ✕
              </Button>
            </Fragment>
          ))}
        </div>
        <div className="tool-row">
          <Button onClick={() => setRows((current) => [...current, emptyRow()])}>+ Add RTAC</Button>
          {projects === null && !loading && (
            <Button onClick={loadProjects}>Load projects</Button>
          )}
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
                    ? `VLAN ${vlan} untagged ${outcome.vlan.before || '—'} → ${outcome.vlan.after}`
                    : `ports already on VLAN ${vlan}`} />
              </div>
            )}
            <div className="vlandeploy-results">
              <span className="vlandeploy-col">RTAC</span>
              <span className="vlandeploy-col">Eth_02</span>
              <span className="vlandeploy-col">Upload</span>
              {outcome.rtacs.map((r) => (
                <Fragment key={r.networkIp}>
                  <span>{r.networkIp} <span className="tool-stats">{r.project}</span></span>
                  <Step step={r.ip}
                    done={r.ip?.changed ? `${r.ip.before} → ${r.ip.after}` : `already ${r.ip?.after}`} />
                  <Step step={r.upload} done="sent" />
                </Fragment>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}
