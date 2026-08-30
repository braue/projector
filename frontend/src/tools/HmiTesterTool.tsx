// HMI Tag Tester — upload a Diagram Builder project, get the tag audit:
// bad tags (used on diagrams but never imported) and duplicates. The .hprb
// binary form needs Diagram Builder's converter at its standard install path
// (Windows only); otherwise upload the converted .hprj.

import { useRef, useState } from 'react'

import { analyzeHmi, analyzeHmiProjectFile } from '../api'
import { CollapsibleSection, DataTable, Spinner } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { HmiReport } from '../types'
import { ProjectFilePick } from './ProjectFilePick'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

export function HmiTesterTool({ project }: ToolProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<HmiReport | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const run = async (name: string, request: () => Promise<HmiReport>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setReport(await request())
      setFileName(name)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const analyze = (file: File) => run(file.name, () => analyzeHmi(file))
  const analyzeProjectFile = (path: string) =>
    run(path.split('/').pop() ?? path, () => analyzeHmiProjectFile(project, path))

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>HMI Tag Tester</h2>
          {busy && <Spinner />}
        </div>
        <div className="preview-subtitle">
          Audits a Diagram Builder HMI project for tags that were never imported
          (dead on the HMI) and tags assigned more than once.
        </div>
      </div>
      <div className="tool-scroll">
        <input
          ref={input}
          type="file"
          accept=".hprj,.hprb"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) analyze(file)
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
            if (file) analyze(file)
          }}
        >
          <b>Drop an .hprj here</b>
          or click to browse — .hprb also works where Diagram Builder is installed
        </button>
        <ProjectFilePick
          project={project}
          extensions={['.hprj', '.hprb']}
          onPick={analyzeProjectFile}
          disabled={busy}
        />
        {error && <div className="tool-error">{error}</div>}

        {report && (
          <>
            <div className="tool-stats">
              {fileName} — {report.totalTags} tags used · {report.importedCount} imported
              · {report.badTags.length} bad · {report.duplicateTags.length} duplicated
            </div>
            <CollapsibleSection title="Bad tags" count={report.badTags.length}>
              {report.badTags.length ? (
                <DataTable
                  maxHeight="320px"
                  columns={[
                    { key: 'tag', label: 'Tag' },
                    { key: 'diagram', label: 'Diagram' },
                  ]}
                  rows={report.badTags.map(({ tag, diagram }, i) => ({
                    id: `${tag}:${i}`,
                    cells: { tag, diagram },
                  }))}
                />
              ) : (
                <div className="tool-empty">None — every used tag exists in the imported lists.</div>
              )}
            </CollapsibleSection>
            <CollapsibleSection title="Duplicate tags" count={report.duplicateTags.length}>
              {report.duplicateTags.length ? (
                <DataTable
                  maxHeight="320px"
                  columns={[
                    { key: 'tag', label: 'Tag' },
                    { key: 'count', label: 'Uses' },
                    { key: 'same', label: 'Same screen' },
                  ]}
                  rows={report.duplicateTags.map(({ tag, count, sameScreen }) => ({
                    id: tag,
                    cells: { tag, count, same: sameScreen ? 'yes' : '' },
                  }))}
                />
              ) : (
                <div className="tool-empty">None — every tag is assigned once.</div>
              )}
            </CollapsibleSection>
            <RunOutputs tool="hmi" run={report.run} reports={report.reports} />
          </>
        )}
      </div>
    </>
  )
}
