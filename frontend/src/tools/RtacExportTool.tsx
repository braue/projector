// RTAC Exporter — bulk-export AcRTAC database projects as XML or EXP, ported
// from the standalone RTAC EXPORTER app. The backend bridge logs into the
// database itself (the fixed login), so there is no credentials form; exports
// land in a tool run (zipped) instead of a fixed server-side folder. The
// project list is the shared one (AcrtacProjectList). Needs the machine with
// the RTAC database (Python + selacrtac) — elsewhere the list says why not.

import { useState } from 'react'

import { startRtacExportJob } from '../api'
import { AcrtacProjectList } from '../components/AcrtacProjectList'
import { Button, SectionHeader, SegmentedControl, Spinner } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { useToolJob } from '../lib/useToolJob'
import type { RtacExportResult, ToolReport } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

interface ExportOutcome {
  run: string
  succeeded: number
  failed: number
  results: RtacExportResult[]
  reports: ToolReport[]
}

export function RtacExportTool(_props: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [format, setFormat] = useState<'xml' | 'exp'>('exp')

  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)
  const { job, running: exporting, start } = useToolJob(
    (result) => setOutcome(result as ExportOutcome),
    setError,
  )

  const startExport = async () => {
    setError(null)
    setOutcome(null)
    try {
      const { job: id } = await startRtacExportJob({
        projects: [...picked],
        format,
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
          <h2>RTAC Exporter</h2>
          {exporting && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <SectionHeader title="Projects" count={picked.size ? `${picked.size} picked` : undefined} />
        <AcrtacProjectList mode="multi" checked={picked} onChange={setPicked} />
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

        {error && <div className="tool-error">{error}</div>}

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
