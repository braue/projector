// HMI Tag Tester — upload a Diagram Builder project, get the tag audit:
// bad tags (used on diagrams but never imported) and duplicates. The .hprb
// binary form needs Diagram Builder's converter at its standard install path
// (Windows only); otherwise upload the converted .hprj.

import { useState } from 'react'

import { analyzeHmi, analyzeHmiProjectFile } from '../api'
import { CollapsibleSection, DataTable, FileDropZone } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { HmiReport } from '../types'
import { ProjectFilePick } from './ProjectFilePick'
import type { ToolProps } from './registry'
import { ToolHeader } from './ToolHeader'

export function HmiTesterTool({ project }: ToolProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<HmiReport | null>(null)
  const [fileName, setFileName] = useState<string | null>(null)

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
  const analyzeProjectFile = (path: string, fromProject: string) =>
    run(path.split('/').pop() ?? path, () => analyzeHmiProjectFile(fromProject, path))

  return (
    <>
      <ToolHeader title="HMI Tag Tester" busy={busy} />
      <div className="tool-scroll">
        <FileDropZone accept=".hprj,.hprb" onFile={analyze}>
          <b>Drop an .hprj here</b>
          or click to browse
        </FileDropZone>
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
                <div className="tool-empty">None.</div>
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
                <div className="tool-empty">None.</div>
              )}
            </CollapsibleSection>
            <CollapsibleSection title="By diagram" count={report.diagrams.length}>
              <DataTable
                maxHeight="320px"
                columns={[
                  { key: 'diagram', label: 'Diagram' },
                  { key: 'tags', label: 'Tags used' },
                  { key: 'bad', label: 'Bad' },
                  { key: 'dupes', label: 'Duplicated on-screen' },
                ]}
                rows={report.diagrams.map(({ diagram, tags, bad, sameScreenDuplicates }) => ({
                  id: diagram,
                  cells: {
                    diagram,
                    tags,
                    bad: bad || '',
                    dupes: sameScreenDuplicates || '',
                  },
                  tone: bad ? ('removed' as const) : undefined,
                }))}
              />
            </CollapsibleSection>
          </>
        )}
      </div>
    </>
  )
}
