// DAC SIM Converter — build simulator (Remote IO + SIM Master) projects from
// an exported DAC bundle: a ZIP holding settings.json beside the "DAC 1",
// "SIM 1", … folders. Staging shows the schemes settings.json declares;
// Convert runs as a job with the converter's own narration as the log, and
// the generated simulator folders land in the run as a ZIP for download /
// save-to-project. Importing the results into AcRTAC stays an AcRTAC step.

import { useEffect, useRef, useState } from 'react'

import {
  DACSIM_TEMPLATE_URL,
  fetchToolJob,
  importDacsimProjectBundle,
  startDacsimConvert,
  uploadDacsimBundle,
} from '../api'
import { Button, DataTable, LinkButton, SectionHeader, Spinner } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { DacsimBundle, DacsimResult, ToolJob } from '../types'
import { ProjectFilePick } from './ProjectFilePick'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

const POLL_MS = 1200

export function DacsimTool({ project }: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [bundle, setBundle] = useState<DacsimBundle | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<ToolJob | null>(null)
  const [result, setResult] = useState<DacsimResult | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

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

  const uploadZip = (file: File) => stage(() => uploadDacsimBundle(file))

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
          Build simulator projects (Remote IO boxes and the SIM Master) from an
          exported DAC bundle — the folder of DAC project XML exports with its
          settings.json — ready to import into AcRTAC.
        </div>
      </div>
      <div className="tool-scroll">
        <SectionHeader title="Bundle" />
        <input
          ref={input}
          type="file"
          accept=".zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) uploadZip(file)
            e.target.value = ''
          }}
        />
        <button
          className="drop-zone as-button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) uploadZip(file)
          }}
        >
          <b>Drop the DAC export bundle ZIP here</b>
          or click to browse — settings.json beside the DAC export folders
        </button>
        <ProjectFilePick
          project={project}
          extensions={['.zip']}
          onPick={(path) => stage(() => importDacsimProjectBundle(project, path))}
          disabled={busy || converting}
        />
        <div className="tool-row">
          <LinkButton href={DACSIM_TEMPLATE_URL} download>
            Starter settings.json
          </LinkButton>
        </div>

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
                cells: scheme,
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
