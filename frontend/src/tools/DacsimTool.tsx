// DAC SIM Converter — build simulator (Remote IO + SIM Master) projects from
// DAC exports already in a project: the chosen project's RTAC entries list
// as a check-off roster, each checked DAC grows its addressing fields, and
// settings.json is generated server-side. One GENERATE runs the whole
// pipeline as a job: convert (the converter's own narration is the log) and
// land the simulator projects back in the project's tree under
// "DAC SIM Converter/". Importing one into the AcRTAC database is the
// project tree's generic "Import to AcRTAC" right-click action.

import { useEffect, useState } from 'react'

import {
  generateDacsim,
  listFiles,
  listProjects,
} from '../api'
import { Button, Checkbox, SectionHeader, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { FILES_CHANGED_EVENT } from '../lib/filesChanged'
import { useToolJob } from '../lib/useToolJob'
import type { DacsimResult, FileNode } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

/** One scheme row of the from-project form. */
interface SchemeRow {
  schemeName: string
  dacPath: string
  /** Comma/space separated in the field; split on generate. */
  dacIps: string
  remoteIp: string
}

/** A scheme name becomes an RTAC variable name in the generated master, so
 *  it must be an IEC identifier: letters/digits/underscores, letter first.
 *  (A "Covington North 13.2kv" scheme crashes the converter mid-build.) */
const SCHEME_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/** "Station A/Feeder 1.rtac" -> "Feeder_1" — the default scheme name,
 *  squeezed into identifier shape. */
function schemeNameFor(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.rtac$/i, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[^A-Za-z]+/, '')
    .replace(/_+$/, '')
    || 'Scheme'
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
  const [result, setResult] = useState<DacsimResult | null>(null)
  const { job, running: generating, start } = useToolJob(
    (settled) => {
      setResult(settled as DacsimResult)
      // The job placed entries in a project's tree behind the sidebar's
      // back — let the app refresh it.
      window.dispatchEvent(new Event(FILES_CHANGED_EVENT))
    },
    setError,
  )

  // The form: the chosen project's RTAC entries as a roster — the user
  // checks which ones are DACs, each checked one grows its addressing and
  // device fields, and the backend writes settings.json from them.
  // Tools are global: the open project is only the dropdown's start value.
  const [projects, setProjects] = useState<string[]>([])
  const [formProject, setFormProject] = useState(project)
  const [rtacEntries, setRtacEntries] = useState<string[] | null>(null)
  const [rows, setRows] = useState<SchemeRow[]>([])
  // ONE master IP for the whole run (settings.json repeats it per scheme
  // because the format demands it).
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
      : [...current, {
          schemeName: schemeNameFor(dacPath),
          dacPath,
          dacIps: '',
          remoteIp: '',
        }])
  }

  const setRow = (index: number, patch: Partial<SchemeRow>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  const badName = rows.find((row) => row.schemeName.trim()
    && !SCHEME_NAME.test(row.schemeName.trim()))
  const rowsReady = rows.length > 0 && !badName
    && rows.every((row) => row.schemeName.trim() && row.dacIps.trim() && row.remoteIp.trim())
    && masterIp.trim() !== ''

  const generate = async () => {
    setError(null)
    setResult(null)
    try {
      const { job: id } = await generateDacsim(formProject, {
        schemes: rows.map((row) => ({
          schemeName: row.schemeName.trim(),
          dacPath: row.dacPath,
          dacIps: row.dacIps.split(/[\s,;]+/).filter(Boolean),
          remoteIp: row.remoteIp.trim(),
        })),
        masterIp: masterIp.trim(),
      })
      start(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>DAC SIM Converter</h2>
          {generating && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <SectionHeader title="Schemes" />
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
                  <Checkbox
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

        {badName && (
          <div className="tool-error">
            Scheme name “{badName.schemeName.trim()}” won't work — it becomes an RTAC
            variable name, so it needs letters, digits, and underscores only,
            starting with a letter (e.g. Feeder_9).
          </div>
        )}
        {error && <div className="tool-error">{error}</div>}

        {job && (
          <div className="tool-joblog">
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
            <RunOutputs tool="dacsim" run={result.run} reports={result.reports} />
          </>
        )}
      </div>
    </>
  )
}
