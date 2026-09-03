// RTAC Exporter — bulk-export AcRTAC database projects as XML or EXP, ported
// from the standalone RTAC EXPORTER app. The backend bridge logs into the
// database itself (same fixed login as the catalog browser), so there is no
// credentials form; exports land in a tool run (zipped) instead of a fixed
// server-side folder. Needs the machine with the RTAC database (Python +
// selacrtac) — elsewhere the load fails with a clear message.

import { useEffect, useState } from 'react'

import { fetchToolJob, listRtacExportProjects, startRtacExportJob } from '../api'
import { Button, Checkbox, SectionHeader, SegmentedControl, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { RtacExportResult, ToolJob, ToolReport } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

const POLL_MS = 1200

interface ExportOutcome {
  run: string
  succeeded: number
  failed: number
  results: RtacExportResult[]
  reports: ToolReport[]
}

export function RtacExportTool(_props: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [projects, setProjects] = useState<string[] | null>(null)
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<'xml' | 'exp'>('xml')

  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<ToolJob | null>(null)
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)

  const load = async () => {
    setBusy(true)
    setError(null)
    setProjects(null)
    setPicked(new Set())
    try {
      setProjects(await listRtacExportProjects())
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

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
          if (state.status === 'done') setOutcome(state.result as ExportOutcome)
          else setError(state.error)
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

  const startExport = async () => {
    setError(null)
    setOutcome(null)
    setJob(null)
    try {
      const { job: id } = await startRtacExportJob({
        projects: [...picked],
        format,
      })
      setJobId(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const visible = (projects ?? []).filter((name) =>
    name.toLowerCase().includes(filter.trim().toLowerCase()),
  )
  const allVisiblePicked = visible.length > 0 && visible.every((name) => picked.has(name))
  const exporting = jobId !== null

  const toggle = (name: string, on: boolean) => {
    setPicked((current) => {
      const next = new Set(current)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  }

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>RTAC Exporter</h2>
          {(busy || exporting) && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <div className="tool-row">
          <Button variant="primary" disabled={busy} onClick={load}>
            Load projects
          </Button>
        </div>

        {error && <div className="tool-error">{error}</div>}

        {projects && (
          <>
            <SectionHeader title="Projects" count={`${picked.size}/${projects.length}`} />
            <div className="tool-row">
              <TextInput
                placeholder="Filter…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <Button
                onClick={() => setPicked(allVisiblePicked
                  ? new Set([...picked].filter((name) => !visible.includes(name)))
                  : new Set([...picked, ...visible]))}
              >
                {allVisiblePicked ? 'Clear shown' : 'Select shown'}
              </Button>
            </div>
            <ul className="rtacx-list">
              {visible.map((name) => (
                <li key={name}>
                  <label className="rtacx-row">
                    <Checkbox checked={picked.has(name)} onChange={(on) => toggle(name, on)} />
                    <span>{name}</span>
                  </label>
                </li>
              ))}
              {visible.length === 0 && <li className="tool-empty">No projects match the filter.</li>}
            </ul>
            <div className="tool-row">
              <SegmentedControl
                options={[
                  { value: 'xml' as const, label: 'XML' },
                  { value: 'exp' as const, label: 'EXP' },
                ]}
                value={format}
                onChange={setFormat}
              />
              <Button
                variant="primary"
                disabled={exporting || picked.size === 0}
                onClick={startExport}
              >
                Export {picked.size > 0 ? `${picked.size} project(s)` : ''}
              </Button>
            </div>
          </>
        )}

        {job && job.status === 'running' && (
          <div className="tool-joblog">
            {job.log.slice(-6).map((line, i) => (
              <div key={i} className="tool-joblog-line">{line}</div>
            ))}
          </div>
        )}

        {outcome && (
          <>
            <div className="tool-stats">
              {outcome.succeeded} exported{outcome.failed > 0 && ` · ${outcome.failed} failed`}
            </div>
            <ul className="rtacx-results">
              {outcome.results.map((entry) => (
                <li key={entry.project} className={entry.success ? 'ok' : 'bad'}>
                  {entry.success ? '✓' : '✕'} {entry.project}
                  {!entry.success && entry.error && ` — ${entry.error}`}
                </li>
              ))}
            </ul>
            <RunOutputs tool="rtac-export" run={outcome.run} reports={outcome.reports} />
          </>
        )}
      </div>
    </>
  )
}
