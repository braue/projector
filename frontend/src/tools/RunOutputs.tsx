// The output strip every tool ends with: each file a run produced, with the
// two ways out — a browser download, and a drag onto a folder of the project
// tree, which saves it there (lib/treeDrag). Same shape as the drawing
// generator's outputs. `downloadOnly` drops the drag for tools whose files
// are transport, not project material (dacsim's ZIP — its saving happens
// through the tool's own Save button, which `rowActions` puts in the same
// row so the two ways out stay side by side).

import type { ReactNode } from 'react'

import { toolRunFileUrl } from '../api'
import { LinkButton, SectionHeader } from '../components/ui'
import { setToolOutputDrag } from '../lib/treeDrag'
import type { ToolReport } from '../types'

export function RunOutputs({
  tool,
  run,
  reports,
  count,
  downloadOnly = false,
  children,
  rowActions,
}: {
  tool: string
  run: string
  reports: ToolReport[]
  /** Override the header count when `children` add rows of their own. */
  count?: number
  /** Report rows get only the Download button, no save-to-project. */
  downloadOnly?: boolean
  /** Extra rows a tool appends after the report rows (e.g. dwgen's Open). */
  children?: ReactNode
  /** A tool's own per-file control, sitting in the report row beside
   *  Download (dacsim's Save to project) instead of on a row of its own. */
  rowActions?: (report: ToolReport) => ReactNode
}) {
  if (!reports.length && !children) return null
  return (
    <div className="tool-outputs">
      <SectionHeader title="Outputs" count={count ?? reports.length} />
      {reports.map((report) => (
        <div
          className={downloadOnly ? 'tool-row' : 'tool-row tool-output-drag'}
          key={report.path}
          draggable={!downloadOnly}
          title={report.path}
          onDragStart={(e) => setToolOutputDrag(e, { tool, run, path: report.path, name: report.label })}
        >
          <span className="tool-output-name">{report.label}</span>
          <LinkButton href={toolRunFileUrl(tool, run, report.path)} download>
            Download
          </LinkButton>
          {rowActions?.(report)}
        </div>
      ))}
      {children}
    </div>
  )
}
