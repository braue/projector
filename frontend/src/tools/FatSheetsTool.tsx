// Automatic FAT → Excel — fill a FAT workbook's Fault Test, Open Phase,
// Miscoordination and Abnormal Condition checkout sheets from the DAC
// simulator's automatic-FAT HTML report. Each input comes from the OS
// (drop / browse) or from a project's tree. The sheets are added in the
// workbook's own style (substation bands taken from its Under Frequency /
// Loss of Source sheets), or replaced in place if a previous run added them.
//
// A workbook picked from a project saves back as a NEW VERSION of that entry
// (nothing touches the tree until Save); an uploaded one goes out through
// Download / Save to project. Tests that did not come back Complete are
// listed with the column they landed in — their Comments cell says why.

import { useState } from 'react'

import { generateFatSheets, saveFatSheetsRun, type FatInput } from '../api'
import { Button, CollapsibleSection, DataTable, FileDropZone, SectionHeader, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { useToolJob } from '../lib/useToolJob'
import type { FatSheetsResult } from '../types'
import { ProjectFilePick } from './ProjectFilePick'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

const ENGINEER_KEY = 'projector.fatsheets.engineer'

function storedEngineer(): string {
  try {
    return localStorage.getItem(ENGINEER_KEY) ?? ''
  } catch {
    return ''
  }
}

function inputLabel(input: FatInput): string {
  return 'file' in input ? `${input.file.name} (from disk)` : `${input.path} (from ${input.project})`
}

function InputPick({
  title,
  accept,
  extensions,
  project,
  value,
  onChange,
  disabled,
}: {
  title: string
  accept: string
  extensions: string[]
  project: string
  value: FatInput | null
  onChange: (input: FatInput | null) => void
  disabled: boolean
}) {
  return (
    <>
      <SectionHeader title={title} />
      {value ? (
        <div className="tool-row">
          <span className="tool-stats">{inputLabel(value)}</span>
          <Button disabled={disabled} onClick={() => onChange(null)}>Change</Button>
        </div>
      ) : (
        <>
          <FileDropZone accept={accept} onFile={(file) => onChange({ file })}>
            <b>Drop the {accept.split(',').join(' / ')} here</b>
            or click to browse
          </FileDropZone>
          <ProjectFilePick
            project={project}
            extensions={extensions}
            onPick={(path, fromProject) => onChange({ project: fromProject, path })}
            disabled={disabled}
          />
        </>
      )}
    </>
  )
}

export function FatSheetsTool({ project }: ToolProps) {
  const [workbook, setWorkbook] = useState<FatInput | null>(null)
  const [report, setReport] = useState<FatInput | null>(null)
  const [engineer, setEngineer] = useState(storedEngineer)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FatSheetsResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const { job, running, start } = useToolJob(
    (settled) => setResult(settled as FatSheetsResult),
    setError,
  )

  // A result describes the inputs it was made from; picking another input
  // makes it stale, so it goes (Save would land the old conversion).
  const changeInput = (set: (input: FatInput | null) => void) => (input: FatInput | null) => {
    set(input)
    setResult(null)
    setSaved(null)
  }

  const convert = async () => {
    if (!workbook || !report || running) return
    setError(null)
    setResult(null)
    setSaved(null)
    try {
      localStorage.setItem(ENGINEER_KEY, engineer.trim())
    } catch {
      // remembering the name is a convenience only
    }
    try {
      const { job: id } = await generateFatSheets({ workbook, report, engineer })
      start(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const save = async () => {
    if (!result) return
    setSaving(true)
    setError(null)
    try {
      const { project: into, placed } = await saveFatSheetsRun(result.run)
      setSaved(`${into} › ${placed}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const saveButton = result?.source && (
    <Button variant="primary" disabled={saving || saved !== null} onClick={save}>
      {saving ? <Spinner /> : saved ? 'Saved' : `Save as new version in ${result.source.project}`}
    </Button>
  )

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>Automatic FAT → Excel</h2>
          {running && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <CollapsibleSection title="What this does">
          <div className="tool-about">
            <p>
              Fills a FAT workbook's <b>Fault Test</b>, <b>Open Phase</b>, <b>Miscoordination</b> and{' '}
              <b>Abnormal Condition</b> checkout sheets from the DAC simulator's automatic-FAT HTML
              report, in the standard FAT format: one column per fault and open phase test, and one
              per feeder on the miscoordination and abnormal sheets (those checkouts are done once
              per feeder) — the feeder's test with the most switching, its abnormal one picked from
              the abnormal fault tests.
            </p>
            <ul>
              <li>
                Adds the four sheets after “Simulator HMI screens”, or replaces them in place if the
                workbook already has them. Nothing else in the workbook changes — macros, images and
                the other sheets are left as they were.
              </li>
              <li>
                Columns are grouped by substation, with the names and colours the workbook's Under
                Frequency / Loss of Source sheets already use.
              </li>
              <li>
                Every answer is read from the report: configuration and event location from each
                test's setup, opened/closed devices from the Switching Summary (fault sheet: *
                opened by protection, ** closed to correct a miscoordination; miscoordination
                sheet: * closed to correct it), YES/NO from the test's status and validation.
              </li>
              <li>
                Tests that did not come back Complete are listed under “Needs review”: a Fail gets
                NO where it applies and a comment saying what went wrong; a Questionable passed
                every validation and gets a comment asking for review.
              </li>
              <li>
                Left blank for you: Return to Normal (the automatic run doesn't test it), and the
                abnormal-tags question on a failed abnormal test.
              </li>
              <li>
                A workbook picked from a project saves back as a new version of that entry (the
                previous one stays in its history); an uploaded one can be downloaded or saved to
                a project.
              </li>
            </ul>
          </div>
        </CollapsibleSection>
        <InputPick
          title="FAT workbook"
          accept=".xlsm,.xlsx"
          extensions={['.xlsm', '.xlsx']}
          project={project}
          value={workbook}
          onChange={changeInput(setWorkbook)}
          disabled={running}
        />
        <InputPick
          title="Automatic FAT report"
          accept=".html,.htm"
          extensions={['.html', '.htm']}
          project={project}
          value={report}
          onChange={changeInput(setReport)}
          disabled={running}
        />
        <div className="tool-row">
          <label>
            FAT test engineer
            <TextInput value={engineer} placeholder="Name" onChange={(e) => setEngineer(e.target.value)} />
          </label>
        </div>
        <div className="tool-row">
          <Button variant="primary" disabled={!workbook || !report || running} onClick={convert}>
            {running ? <Spinner /> : 'Fill checkout sheets'}
          </Button>
        </div>

        {error && <div className="tool-error">{error}</div>}
        {job && (
          <div className="tool-joblog">
            {job.log.slice(-8).map((entry, i) => (
              <div key={i} className="tool-joblog-line">{entry}</div>
            ))}
          </div>
        )}

        {result && (
          <>
            <SectionHeader title="Sheets" count={result.sheets.length} />
            {result.sheets.map((sheet) => (
              <div className="tool-row" key={sheet.kind}>
                <span className="tool-stats">
                  {sheet.name} — {sheet.count} test{sheet.count === 1 ? '' : 's'}
                  {sheet.inReport > sheet.count
                    ? ` (${sheet.kind === 'fault' || sheet.kind === 'openPhase' ? 'clean passes that restored nothing left off' : 'one per feeder'}, of ${sheet.inReport} in the report)`
                    : ''}
                  {sheet.replaced ? ' (replaced the existing sheet)' : ' (added)'}
                </span>
              </div>
            ))}
            <div className="tool-row">
              <span className="tool-stats">
                Substation bands from the workbook:{' '}
                {result.bands.substations.length
                  ? result.bands.substations.map((s) => `${s.name} (${s.feeders.join(', ')})`).join(' · ')
                  : 'none found'}
              </span>
            </div>
            {result.bands.unbanded.length > 0 && (
              <div className="tool-error">
                No Under Frequency / Loss of Source sheet names a substation for{' '}
                {result.bands.unbanded.join(', ')} — those columns are banded by feeder instead.
              </div>
            )}

            <CollapsibleSection title="Needs review" count={result.flagged.length}>
              {result.flagged.length ? (
                <DataTable
                  maxHeight="320px"
                  columns={[
                    { key: 'column', label: 'Column' },
                    { key: 'feeder', label: 'Feeder' },
                    { key: 'status', label: 'Status' },
                    { key: 'comment', label: 'Comment written' },
                  ]}
                  rows={result.flagged.map((f) => ({
                    id: String(f.index),
                    cells: { column: f.column, feeder: f.feeder, status: f.status, comment: f.comment },
                    tone: f.status === 'Fail' ? ('removed' as const) : undefined,
                  }))}
                />
              ) : (
                <div className="tool-empty">Every test came back Complete.</div>
              )}
            </CollapsibleSection>
            <div className="tool-row">
              <span className="tool-stats">
                Return to Normal answers are left blank — the automatic run doesn't exercise RTN.
              </span>
            </div>

            <RunOutputs
              tool="fatsheets"
              run={result.run}
              reports={result.reports}
              downloadOnly={Boolean(result.source)}
              rowActions={saveButton ? () => saveButton : undefined}
            >
              {saved && (
                <div className="tool-row">
                  <span className="tool-stats">Saved: {saved} — the previous workbook is kept as a version.</span>
                </div>
              )}
            </RunOutputs>
          </>
        )}
      </div>
    </>
  )
}
