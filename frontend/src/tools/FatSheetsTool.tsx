// Automatic FAT → Excel — fill a FAT workbook's Fault Test, Open Phase,
// Miscoordination and Abnormal Condition checkout sheets from the DAC
// simulator's automatic-FAT HTML report. Each input comes from the OS
// (drop / browse) or from a project's tree. The sheets are added in the
// workbook's own style, or replaced in place if a previous run added them —
// all four, every run. Only the feeders checked off the report's list are
// converted; each is given its substation here, and each substation its band
// colour (remembered between runs, by feeder and by substation name).
//
// A workbook picked from a project saves back as a NEW VERSION of that entry
// (nothing touches the tree until Save); an uploaded one goes out through
// Download / Save to project. Tests that did not come back Complete are
// listed with the column they landed in — their Comments cell says why.

import { Fragment, useEffect, useState } from 'react'

import { fetchFatFeeders, generateFatSheets, saveFatSheetsRun, type FatInput } from '../api'
import { Button, Checkbox, CollapsibleSection, DataTable, FileDropZone, SectionHeader, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { saveSettings, setting } from '../lib/settings'
import { useToolJob } from '../lib/useToolJob'
import type { FatSheetsResult } from '../types'
import { ProjectFilePick } from './ProjectFilePick'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'
import { ToolHeader } from './ToolHeader'

const ENGINEER_KEY = 'fatSheetsEngineer'
const BANDS_KEY = 'fatSheetsBands'
// Band colours offered to a new substation, in turn: Excel's light fills.
const BAND_COLORS = ['#92D050', '#FFC000', '#9BC2E6', '#F4B084', '#FFE699', '#C9C9C9', '#B4A7D6', '#A9D08E']

interface SavedBands {
  /** feeder → substation name */
  feeders: Record<string, string>
  /** substation name → '#RRGGBB' */
  colors: Record<string, string>
}

const UNPAIRED_REASON: Record<string, string> = {
  'fault only': 'No open phase test',
  'open phase only': 'No fault test',
  'no shared configuration': 'No shared configuration',
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
  const [engineer, setEngineer] = useState(() => setting(ENGINEER_KEY, ''))
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<FatSheetsResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  // The report's feeders, all checked when it is picked.
  const [feeders, setFeeders] = useState<{ feeder: string; tests: number }[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [feedersError, setFeedersError] = useState<string | null>(null)
  useEffect(() => {
    setFeeders(null)
    setFeedersError(null)
    if (!report) return
    let live = true
    fetchFatFeeders(report).then(
      (r) => {
        if (!live) return
        setFeeders(r.feeders)
        setChecked(new Set(r.feeders.map((f) => f.feeder)))
      },
      (err) => live && setFeedersError(errorMessage(err)),
    )
    return () => {
      live = false
    }
  }, [report])
  // Substation per feeder and colour per substation, remembered by name.
  const [bandMemo, setBandMemo] = useState<SavedBands>(() => {
    const saved = setting<Partial<SavedBands>>(BANDS_KEY, {})
    return { feeders: saved.feeders ?? {}, colors: saved.colors ?? {} }
  })
  const substationOf = (feeder: string) => bandMemo.feeders[feeder] ?? ''
  const setSubstation = (feeder: string, name: string) => {
    setBandMemo((m) => ({ ...m, feeders: { ...m.feeders, [feeder]: name } }))
    setResult(null)
    setSaved(null)
  }
  const pickedFeeders = (feeders ?? []).map((f) => f.feeder).filter((f) => checked.has(f))
  // Substations in the order their first picked feeder appears.
  const substations = [...new Set(pickedFeeders.map(substationOf).map((n) => n.trim()).filter(Boolean))]
  // A substation without a remembered colour takes the next one no other
  // band on screen (or remembered) is using.
  const defaults = new Map<string, string>()
  {
    const used = new Set([...Object.values(bandMemo.colors), ...substations.map((n) => bandMemo.colors[n])])
    for (const name of substations) {
      if (bandMemo.colors[name]) continue
      const color = BAND_COLORS.find((c) => !used.has(c)) ?? BAND_COLORS[defaults.size % BAND_COLORS.length]
      used.add(color)
      defaults.set(name, color)
    }
  }
  const colorOf = (name: string) => bandMemo.colors[name] ?? defaults.get(name) ?? BAND_COLORS[0]
  const setColor = (name: string, color: string) => {
    setBandMemo((m) => ({ ...m, colors: { ...m.colors, [name]: color } }))
    setResult(null)
    setSaved(null)
  }
  const bands = substations.map((name) => ({
    name,
    color: colorOf(name),
    feeders: pickedFeeders.filter((f) => substationOf(f).trim() === name),
  }))

  const toggleFeeder = (feeder: string, on: boolean) => {
    setChecked((current) => {
      const next = new Set(current)
      if (on) next.add(feeder)
      else next.delete(feeder)
      return next
    })
    setResult(null)
    setSaved(null)
  }

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
    // Remembering these is a convenience only. A new substation's colour is
    // pinned now so it doesn't shift when another substation is added.
    const colors = { ...bandMemo.colors }
    for (const band of bands) colors[band.name] = band.color
    setBandMemo((m) => ({ ...m, colors }))
    saveSettings({ [ENGINEER_KEY]: engineer.trim(), [BANDS_KEY]: { feeders: bandMemo.feeders, colors } }).catch(() => {})
    try {
      const { job: id } = await generateFatSheets({ workbook, report, engineer, feeders: pickedFeeders, bands })
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
      <ToolHeader title="Automatic FAT → Excel" busy={running} />
      <div className="tool-scroll">
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
        {report && (
          <>
            <SectionHeader title="Feeders" count={feeders ? checked.size : undefined} />
            {feedersError && <div className="tool-error">{feedersError}</div>}
            {!feeders && !feedersError && <Spinner />}
            {feeders && (
              <>
                <div className="tool-row">
                  <Button disabled={running} onClick={() => {
                    setChecked(new Set(checked.size === feeders.length ? [] : feeders.map((f) => f.feeder)))
                    setResult(null)
                    setSaved(null)
                  }}>
                    {checked.size === feeders.length ? 'None' : 'All'}
                  </Button>
                </div>
                <div className="fat-feeders">
                  <span />
                  <span className="fat-col">Feeder</span>
                  <span className="fat-col">Tests</span>
                  <span className="fat-col">Substation</span>
                  {feeders.map((f) => (
                    <Fragment key={f.feeder}>
                      <Checkbox checked={checked.has(f.feeder)} disabled={running}
                        onChange={(on) => toggleFeeder(f.feeder, on)} />
                      <span className={checked.has(f.feeder) ? 'fat-feeder' : 'fat-feeder off'}>{f.feeder}</span>
                      <span className="tool-stats">{f.tests}</span>
                      <TextInput value={substationOf(f.feeder)} list="fat-substations"
                        disabled={running || !checked.has(f.feeder)}
                        onChange={(e) => setSubstation(f.feeder, e.target.value)} />
                    </Fragment>
                  ))}
                </div>
                <datalist id="fat-substations">
                  {[...new Set(Object.values(bandMemo.feeders).map((n) => n.trim()).filter(Boolean))]
                    .map((name) => <option key={name} value={name} />)}
                </datalist>
                {bands.length > 0 && (
                  <div className="fat-bands">
                    {bands.map((band) => (
                      <label key={band.name} className="fat-band" style={{ background: band.color }}>
                        <input type="color" value={band.color} disabled={running}
                          onChange={(e) => setColor(band.name, e.target.value.toUpperCase())} />
                        <span className="fat-band-name">{band.name}</span>
                        <span className="fat-band-feeders">{band.feeders.join(', ')}</span>
                      </label>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}
        <div className="tool-row">
          <TextInput label="Engineer" value={engineer} placeholder="Name" onChange={(e) => setEngineer(e.target.value)} />
        </div>
        <div className="tool-row">
          <Button variant="primary" disabled={!workbook || !report || !feeders || !checked.size || running} onClick={convert}>
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
                    ? ` (${sheet.kind === 'fault' || sheet.kind === 'openPhase' ? 'one per segment, paired with the other sheet' : 'one per feeder'}, of ${sheet.inReport} for these feeders)`
                    : ''}
                  {sheet.replaced ? ' (replaced the existing sheet)' : ' (added)'}
                </span>
              </div>
            ))}
            <div className="tool-row">
              <span className="tool-stats">
                Substations:{' '}
                {result.bands.substations.length
                  ? result.bands.substations.map((s) => `${s.name} (${s.feeders.join(', ')})`).join(' · ')
                  : 'none'}
              </span>
            </div>
            {result.bands.unbanded.length > 0 && (
              <div className="tool-error">
                Banded by feeder (no substation): {result.bands.unbanded.join(', ')}
              </div>
            )}

            {result.unpaired?.length > 0 && (
              <CollapsibleSection title="Left off Fault / Open Phase" count={result.unpaired.length}>
                <DataTable
                  maxHeight="320px"
                  columns={[
                    { key: 'location', label: 'Segment' },
                    { key: 'feeder', label: 'Feeder' },
                    { key: 'reason', label: 'Why' },
                    { key: 'tests', label: 'Tests' },
                  ]}
                  rows={result.unpaired.map((u) => ({
                    id: u.location,
                    cells: {
                      location: u.location,
                      feeder: u.feeders.join(', '),
                      reason: UNPAIRED_REASON[u.reason] ?? u.reason,
                      tests: u.tests.join(', '),
                    },
                  }))}
                />
              </CollapsibleSection>
            )}

            {result.abnormalUnmatched?.length > 0 && (
              <div className="tool-error">
                Left off Abnormal (no matching re-run): {result.abnormalUnmatched.join(', ')}
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
                    { key: 'comment', label: 'Comment' },
                  ]}
                  rows={result.flagged.map((f) => ({
                    id: String(f.index),
                    cells: { column: f.column, feeder: f.feeder, status: f.status, comment: f.comment },
                    tone: f.status === 'Fail' ? ('removed' as const) : undefined,
                  }))}
                />
              ) : (
                <div className="tool-empty">All complete.</div>
              )}
            </CollapsibleSection>

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
