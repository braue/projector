// DAC SIM Converter — build simulator (Remote IO + SIM Master) projects from
// DAC exports already in a project: the chosen project's RTAC entries list
// as a check-off roster, each checked DAC grows its addressing fields, and
// settings.json is generated server-side. Convert runs as a job with the
// converter's own narration as the log, and the generated simulator folders
// land in the run as a ZIP for download / save-to-project. Importing the
// results into AcRTAC stays an AcRTAC step.

import { useEffect, useState } from 'react'

import {
  fetchToolJob,
  listFiles,
  listProjects,
  stageDacsimFromProject,
  startDacsimConvert,
} from '../api'
import { Button, DataTable, SectionHeader, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { DacsimBundle, DacsimResult, FileNode, ToolJob } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

const POLL_MS = 1200

/** One scheme row of the from-project form. */
interface SchemeRow {
  schemeName: string
  dacPath: string
  /** Comma/space separated in the field; split on stage. */
  dacIps: string
  remoteIp: string
}

/** "Station A/Feeder 1.rtac" -> "Feeder 1" — the default scheme name. */
function schemeNameFor(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.rtac$/i, '').replace(/[^A-Za-z0-9 _.-]/g, '_')
}

/** Every RTAC export entry in a project tree (the candidates for DACs). */
function rtacPaths(nodes: FileNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'folder') rtacPaths(node.children, out)
    else if (node.kind === 'rtac') out.push(node.path)
  }
  return out
}

export function DacsimTool({ project }: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [bundle, setBundle] = useState<DacsimBundle | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<ToolJob | null>(null)
  const [result, setResult] = useState<DacsimResult | null>(null)
  const [busy, setBusy] = useState(false)

  // The from-project form: the chosen project's RTAC entries as a roster —
  // the user checks which ones are DACs, each checked one grows its
  // addressing fields, and the backend writes settings.json from them.
  // Tools are global: the open project is only the dropdown's start value.
  const [projects, setProjects] = useState<string[]>([])
  const [formProject, setFormProject] = useState(project)
  const [rtacEntries, setRtacEntries] = useState<string[] | null>(null)
  const [rows, setRows] = useState<SchemeRow[]>([])
  // One master IP for the whole run (settings.json repeats it per scheme
  // because the format demands it, not because it varies).
  const [masterIp, setMasterIp] = useState('')

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {})
  }, [])

  // The roster for the chosen project. Refreshed via onFocusCapture below,
  // so exports added while the (latched) tool pane sat hidden still show.
  const loadEntries = (chosen: string) => {
    listFiles(chosen)
      .then((tree) => setRtacEntries(rtacPaths(tree)))
      .catch((err) => setError(errorMessage(err)))
  }

  useEffect(() => {
    setRtacEntries(null)
    if (formProject) loadEntries(formProject)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formProject])

  const switchProject = (name: string) => {
    if (!name || name === formProject) return
    setFormProject(name)
    setRows([])
    setError(null)
  }

  const toggleEntry = (dacPath: string) => {
    setError(null)
    setRows((current) => current.some((row) => row.dacPath === dacPath)
      ? current.filter((row) => row.dacPath !== dacPath)
      : [...current, { schemeName: schemeNameFor(dacPath), dacPath, dacIps: '', remoteIp: '' }])
  }

  const setRow = (index: number, patch: Partial<SchemeRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const rowsReady = rows.length > 0
    && rows.every((row) => row.schemeName.trim() && row.dacIps.trim() && row.remoteIp.trim())
    && masterIp.trim() !== ''

  // Poll the conversion job until it settles.
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    const tick = async () => {
      try {
        const state = await fetchToolJob(jobId)
        if (cancelled) return
        setJob(state)
        if (state.status === 'running') {
          window.setTimeout(tick, POLL_MS)
        } else {
          setJobId(null)
          if (state.status === 'done') setResult(state.result as DacsimResult)
        }
      } catch (err) {
        if (!cancelled) {
          setJobId(null)
          setError(errorMessage(err))
        }
      }
    }
    tick()
    return () => {
      cancelled = true
    }
  }, [jobId])

  const stage = async (request: () => Promise<DacsimBundle>) => {
    setError(null)
    setResult(null)
    setJob(null)
    setBusy(true)
    try {
      setBundle(await request())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const stageFromForm = () => stage(() => stageDacsimFromProject(formProject, {
    schemes: rows.map((row) => ({
      schemeName: row.schemeName.trim(),
      dacPath: row.dacPath,
      dacIps: row.dacIps.split(/[\s,;]+/).filter(Boolean),
      remoteIp: row.remoteIp.trim(),
    })),
    masterIp: masterIp.trim(),
  }))

  const convert = async () => {
    if (!bundle) return
    setError(null)
    setResult(null)
    setJob(null)
    try {
      const { job: id } = await startDacsimConvert(bundle.run)
      setJobId(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const converting = jobId !== null

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>DAC SIM Converter</h2>
          {(busy || converting) && <Spinner />}
        </div>
        <div className="preview-subtitle">
          Build simulator projects (Remote IO boxes and the SIM Master) from
          DAC exports already in a project, ready to import into AcRTAC.
        </div>
      </div>
      <div className="tool-scroll">
        <SectionHeader title="Schemes from a project" />
        <div className="preview-subtitle">
          Every RTAC export in the chosen project is listed — check the ones
          that are DACs, fill in each one's addressing, and settings.json is
          generated for you.
        </div>
        <div className="tool-row">
          <Select
            label="Project"
            value={formProject}
            options={projects.length ? projects : [formProject].filter(Boolean)}
            onChange={switchProject}
          />
        </div>
        {rtacEntries !== null && (
          <div
            className="tool-col dacsim-roster"
            onFocusCapture={() => loadEntries(formProject)}
          >
            {rtacEntries.length === 0 && (
              <div className="tool-stats">No RTAC exports in {formProject}</div>
            )}
            {rtacEntries.map((path) => {
              const checked = rows.some((row) => row.dacPath === path)
              return (
                <label key={path} className={checked ? 'dacsim-entry on' : 'dacsim-entry'}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy || converting}
                    onChange={() => toggleEntry(path)}
                  />
                  <span className="dacsim-entry-name">{schemeNameFor(path)}</span>
                  <span className="tool-stats">{path}</span>
                </label>
              )
            })}
          </div>
        )}
        {rows.map((row, index) => (
          <div className="tool-row" key={row.dacPath}>
            <TextInput
              label={index === 0 ? 'Scheme' : undefined}
              value={row.schemeName}
              onChange={(e) => setRow(index, { schemeName: e.target.value })}
            />
            <TextInput
              label={index === 0 ? 'DAC IPs' : undefined}
              value={row.dacIps}
              placeholder="192.168.199.21, 192.168.199.121"
              onChange={(e) => setRow(index, { dacIps: e.target.value })}
            />
            <TextInput
              label={index === 0 ? 'Remote IO IP' : undefined}
              value={row.remoteIp}
              placeholder="192.168.254.21"
              onChange={(e) => setRow(index, { remoteIp: e.target.value })}
            />
            <Button onClick={() => toggleEntry(row.dacPath)}>✕</Button>
          </div>
        ))}
        {rows.length > 0 && (
          <>
            <div className="tool-row">
              <TextInput
                label="Master IP"
                value={masterIp}
                placeholder="192.168.254.11"
                onChange={(e) => setMasterIp(e.target.value)}
              />
            </div>
            <div className="tool-row">
              <Button variant="primary" disabled={!rowsReady || busy || converting} onClick={stageFromForm}>
                Stage schemes
              </Button>
            </div>
          </>
        )}

        {error && <div className="tool-error">{error}</div>}

        {bundle && (
          <>
            <SectionHeader title="Schemes" />
            <DataTable
              maxHeight="240px"
              columns={[
                { key: 'schemeName', label: 'Scheme' },
                { key: 'dacFolder', label: 'DAC folder' },
                { key: 'remoteFolder', label: 'Remote IO folder' },
                { key: 'logicFolder', label: 'Master folder' },
              ]}
              rows={bundle.schemes.map((scheme, i) => ({
                id: `${scheme.schemeName}:${i}`,
                cells: { ...scheme },
              }))}
            />
            <div className="tool-row">
              <Button variant="primary" disabled={converting} onClick={convert}>
                Convert
              </Button>
              {result && (
                <span className="tool-stats">
                  {result.remoteProjects} Remote IO project(s) + {result.masterFolder} —
                  {' '}{result.files} files
                </span>
              )}
            </div>
          </>
        )}

        {job && (
          <div className="tool-joblog">
            {job.status === 'error' && <div className="tool-error">{job.error}</div>}
            {job.log.slice(-10).map((entry, i) => (
              <div key={i} className="tool-joblog-line">{entry}</div>
            ))}
          </div>
        )}

        {result && (
          <RunOutputs tool="dacsim" run={result.run} reports={result.reports} />
        )}
      </div>
    </>
  )
}
