// DAC SIM Converter — build simulator (Remote IO + SIM Master) projects from
// DAC exports already in a project: the chosen project's RTAC entries list
// as a check-off roster, each checked DAC grows its addressing + device
// fields, and settings.json is generated server-side. One GENERATE runs the
// whole pipeline as a job: convert (the converter's own narration is the
// log), land the simulator projects back in the project's tree under
// "DAC SIM Converter/", and import each into AcRTAC with the given device
// type + firmware.

import { useEffect, useState } from 'react'

import {
  fetchToolJob,
  generateDacsim,
  listFiles,
  listProjects,
} from '../api'
import { Button, SectionHeader, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { FILES_CHANGED_EVENT } from '../lib/filesChanged'
import type { DacsimResult, FileNode, ToolJob } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

const POLL_MS = 1200

/** One scheme row of the from-project form. */
interface SchemeRow {
  schemeName: string
  dacPath: string
  /** Comma/space separated in the field; split on generate. */
  dacIps: string
  remoteIp: string
  /** AcRTAC hardware type for this scheme's Remote IO import (3555, 3530…). */
  deviceType: string
  /** AcRTAC firmware revision for the import ("R151"). */
  firmware: string
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
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<ToolJob | null>(null)
  const [result, setResult] = useState<DacsimResult | null>(null)

  // The form: the chosen project's RTAC entries as a roster — the user
  // checks which ones are DACs, each checked one grows its addressing and
  // device fields, and the backend writes settings.json from them.
  // Tools are global: the open project is only the dropdown's start value.
  const [projects, setProjects] = useState<string[]>([])
  const [formProject, setFormProject] = useState(project)
  const [rtacEntries, setRtacEntries] = useState<string[] | null>(null)
  const [rows, setRows] = useState<SchemeRow[]>([])
  // ONE master IP + device/firmware for the whole run (settings.json
  // repeats the IP per scheme because the format demands it; the device
  // pair targets the single SIM Master import).
  const [master, setMaster] = useState({ ip: '', deviceType: '', firmware: '' })

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
      : [...current, {
          schemeName: schemeNameFor(dacPath),
          dacPath,
          dacIps: '',
          remoteIp: '',
          deviceType: '',
          firmware: '',
        }])
  }

  const setRow = (index: number, patch: Partial<SchemeRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const rowsReady = rows.length > 0
    && rows.every((row) => row.schemeName.trim() && row.dacIps.trim()
      && row.remoteIp.trim() && row.deviceType.trim() && row.firmware.trim())
    && master.ip.trim() !== '' && master.deviceType.trim() !== '' && master.firmware.trim() !== ''

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
          if (state.status === 'done') {
            setResult(state.result as DacsimResult)
            // The job placed entries in a project's tree behind the
            // sidebar's back — let the app refresh it.
            window.dispatchEvent(new Event(FILES_CHANGED_EVENT))
          }
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

  const generate = async () => {
    setError(null)
    setResult(null)
    setJob(null)
    try {
      const { job: id } = await generateDacsim(formProject, {
        schemes: rows.map((row) => ({
          schemeName: row.schemeName.trim(),
          dacPath: row.dacPath,
          dacIps: row.dacIps.split(/[\s,;]+/).filter(Boolean),
          remoteIp: row.remoteIp.trim(),
          deviceType: row.deviceType.trim(),
          firmware: row.firmware.trim(),
        })),
        masterIp: master.ip.trim(),
        masterDeviceType: master.deviceType.trim(),
        masterFirmware: master.firmware.trim(),
      })
      setJobId(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const generating = jobId !== null

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>DAC SIM Converter</h2>
          {generating && <Spinner />}
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
          that are DACs and fill in each one's addressing and AcRTAC device.
          Generate converts, adds the simulator projects to the project under
          "DAC SIM Converter", and imports them into AcRTAC.
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
                    disabled={generating}
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
            <TextInput
              label={index === 0 ? 'Device' : undefined}
              value={row.deviceType}
              placeholder="3555"
              onChange={(e) => setRow(index, { deviceType: e.target.value })}
            />
            <TextInput
              label={index === 0 ? 'Firmware' : undefined}
              value={row.firmware}
              placeholder="R151"
              onChange={(e) => setRow(index, { firmware: e.target.value })}
            />
            <Button onClick={() => toggleEntry(row.dacPath)}>✕</Button>
          </div>
        ))}
        {rows.length > 0 && (
          <>
            <div className="tool-row">
              <TextInput
                label="Master IP"
                value={master.ip}
                placeholder="192.168.254.11"
                onChange={(e) => setMaster((m) => ({ ...m, ip: e.target.value }))}
              />
              <TextInput
                label="Master device"
                value={master.deviceType}
                placeholder="3555"
                onChange={(e) => setMaster((m) => ({ ...m, deviceType: e.target.value }))}
              />
              <TextInput
                label="Master firmware"
                value={master.firmware}
                placeholder="R151"
                onChange={(e) => setMaster((m) => ({ ...m, firmware: e.target.value }))}
              />
            </div>
            <div className="tool-row">
              <Button variant="primary" disabled={!rowsReady || generating} onClick={generate}>
                Generate
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

        {error && <div className="tool-error">{error}</div>}

        {job && (
          <div className="tool-joblog">
            {job.status === 'error' && <div className="tool-error">{job.error}</div>}
            {job.log.slice(-10).map((entry, i) => (
              <div key={i} className="tool-joblog-line">{entry}</div>
            ))}
          </div>
        )}

        {result && (
          <>
            {result.placed.length > 0 && (
              <div className="tool-stats">
                Added to the project: {result.placed.join(', ')}
              </div>
            )}
            {result.importError !== null && (
              <div className="tool-error">AcRTAC import: {result.importError}</div>
            )}
            {result.imports?.map((entry) => (
              <div
                key={entry.name}
                className={entry.success ? 'tool-status' : 'tool-error'}
              >
                {entry.success ? '✓' : '✕'} AcRTAC: {entry.name}
                {entry.error ? ` — ${entry.error}` : ''}
              </div>
            ))}
            <RunOutputs tool="dacsim" run={result.run} reports={result.reports} />
          </>
        )}
      </div>
    </>
  )
}
