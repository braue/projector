// The output strip every tool ends with: each file a run produced, with the
// two ways out — a browser download, and a copy into a chosen project's
// Files store (the "Save to project…" dropdown saves on pick). Same shape as
// the drawing generator's outputs.

import { useEffect, useState, type ReactNode } from 'react'

import { listProjects, saveToolFileToProject, toolRunFileUrl } from '../api'
import { LinkButton, SectionHeader, Select } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { ToolReport } from '../types'

export function RunOutputs({
  tool,
  run,
  reports,
  count,
  children,
}: {
  tool: string
  run: string
  reports: ToolReport[]
  /** Override the header count when `children` add rows of their own. */
  count?: number
  /** Extra rows a tool appends after the report rows (e.g. dwgen's Open). */
  children?: ReactNode
}) {
  const [status, setStatus] = useState<string | null>(null)
  const [projects, setProjects] = useState<string[]>([])

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {})
  }, [])

  const saveToProject = async (report: ToolReport, target: string) => {
    setStatus(null)
    try {
      const { added } = await saveToolFileToProject({ project: target, tool, run, path: report.path })
      setStatus(`Saved to ${target} › Files as ${added[0]}`)
    } catch (err) {
      setStatus(`Save failed: ${errorMessage(err)}`)
    }
  }

  if (!reports.length && !children) return null
  return (
    <div className="tool-outputs">
      <SectionHeader title="Outputs" count={count ?? reports.length} />
      {reports.map((report) => (
        <div className="tool-row" key={report.path}>
          <span className="tool-output-name" title={report.path}>{report.label}</span>
          <LinkButton href={toolRunFileUrl(tool, run, report.path)} download>
            Download
          </LinkButton>
          {/* Picking a project saves immediately; value stays pinned to the
              placeholder so it reads (and re-fires) like a button. */}
          <Select
            value=""
            variant="action"
            placeholder="Save to project…"
            options={projects}
            onChange={(target) => {
              if (target) saveToProject(report, target)
            }}
          />
        </div>
      ))}
      {children}
      {status && <div className="tool-status">{status}</div>}
    </div>
  )
}
