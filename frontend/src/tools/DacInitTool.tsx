// CLECO DAC Inits — the projector-native replacement for the "DAC Inits"
// workbook + copy/paste. Pick a DAC .rtac already in a project, describe the
// devices you're adding (reclosers, transformers, feeders/breakers), and the
// backend generates the same Structured-Text init blocks the macro did,
// appends them to the project's Init_* POUs, and — on the explicit Save —
// lands the result as a NEW VERSION of that .rtac entry (note "Auto-add
// inits"). Nothing touches the tree until Save.
//
// Project-level constants (device prefixes, SCADA map, voltage, PT sets, and
// the 651R DNP point counts) live in one Parameters row and apply to every
// device, so the per-device rows stay narrow — the same split the workbook's
// "Project Info" sheet used.
//
// An identifier the project already uses isn't quietly skipped: generate comes
// back with it flagged, and the warning below offers to overwrite — which
// regenerates that device's init block where it already sits (so a changed
// capacity is an edit, not a second block at the bottom of the POU). Choosing
// overwrite just re-runs generate with those names; nothing lands until Save.

import { Fragment, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import {
  generateDacInit,
  listFiles,
  listProjects,
  saveDacInitRun,
} from '../api'
import { Button, Checkbox, SectionHeader, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { rtacPaths } from '../lib/fileNodes'
import { FILES_CHANGED_EVENT } from '../lib/filesChanged'
import { useToolJob } from '../lib/useToolJob'
import type { DacInitResult } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

const SOURCE_SLOTS = 6

interface Params {
  recPrefix: string
  scadaMap: string
  fdrPrefix: string
  bkrPrefix: string
  voltage: string
  ptA: string
  ptB: string
  numBi: string
  numAi: string
  numBo: string
  numAo: string
  numCnt: string
}

const DEFAULT_PARAMS: Params = {
  recPrefix: 'SEL_651R2',
  scadaMap: 'DMS_MAP',
  fdrPrefix: 'FDR',
  bkrPrefix: 'BKR',
  voltage: '13.2kV',
  ptA: 'Set2',
  ptB: 'Set1',
  numBi: '69',
  numAi: '18',
  numBo: '13',
  numAo: '0',
  numCnt: '0',
}

interface SourceRow { feeder: string; sg: string }
interface RecRow {
  number: string
  isSwitch: boolean
  normallyOpen: boolean
  capacity: string
  circuit: string
  sources: SourceRow[]
}
interface XfmrRow { substation: string; transformer: string; ratedMva: string; dnpClient: string }
interface FbRow { number: string; capacity: string; normallyOpen: boolean; downstream: boolean; dnpClient: string }

// The Parameters row, as data — one caption per field, so a field can't be
// wired to the wrong key by copy-paste. Split into the two displayed rows.
const PARAM_ROWS: [keyof Params, string][][] = [
  [['recPrefix', 'Recloser prefix'], ['scadaMap', 'SCADA map'],
    ['fdrPrefix', 'Feeder prefix'], ['bkrPrefix', 'Breaker prefix']],
  [['ptA', 'PT A / B'], ['ptB', '\u00a0'], ['numBi', '# BI/AI/BO'], ['numAi', '\u00a0'],
    ['numBo', '\u00a0'], ['numAo', '# AO/Cnt'], ['numCnt', '\u00a0']],
]

const emptySources = (): SourceRow[] =>
  Array.from({ length: SOURCE_SLOTS }, () => ({ feeder: '', sg: '0' }))
const newRec = (): RecRow => ({
  number: '', isSwitch: false, normallyOpen: false, capacity: '', circuit: '', sources: emptySources(),
})
const newXfmr = (): XfmrRow => ({ substation: '', transformer: '', ratedMva: '', dnpClient: '' })
const newFb = (): FbRow => ({ number: '', capacity: '', normallyOpen: false, downstream: false, dnpClient: '' })

export function DacInitTool({ project }: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DacInitResult | null>(null)
  // Which of the reported conflicts to overwrite on the next generate. Seeded
  // to all of them — you got here by listing those devices on purpose.
  const [overwrite, setOverwrite] = useState<string[]>([])
  const { job, running: generating, start } = useToolJob(
    (settled) => {
      const done = settled as DacInitResult
      setResult(done)
      setOverwrite(done.conflicts.map((conflict) => conflict.name))
    },
    setError,
  )

  const [projects, setProjects] = useState<string[]>([])
  const [formProject, setFormProject] = useState(project)
  const [rtacEntries, setRtacEntries] = useState<string[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS)
  const [reclosers, setReclosers] = useState<RecRow[]>([])
  const [transformers, setTransformers] = useState<XfmrRow[]>([])
  const [feedersBreakers, setFeedersBreakers] = useState<FbRow[]>([])

  // "Save to project": the project the run was configured from, captured at
  // generate so switching the dropdown afterwards can't misplace it.
  const generatedFrom = useRef('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    listProjects().then(setProjects).catch(() => {})
  }, [])

  const loadEntries = (chosen: string) => {
    listFiles(chosen)
      .then((tree) => {
        const paths = rtacPaths(tree)
        setRtacEntries(paths)
        setSelectedPath((current) => (paths.includes(current) ? current : paths[0] ?? ''))
      })
      .catch((err) => setError(errorMessage(err)))
  }

  useEffect(() => {
    if (formProject) loadEntries(formProject)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formProject])

  const setParam = (patch: Partial<Params>) => setParams((p) => ({ ...p, ...patch }))
  // Patch/remove one row of a device table — the same two lines for all three.
  const rowOps = <T,>(setRows: Dispatch<SetStateAction<T[]>>) => ({
    patch: (i: number, patch: Partial<T>) =>
      setRows((rows) => rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row))),
    remove: (i: number) => setRows((rows) => rows.filter((_, idx) => idx !== i)),
  })
  const recOps = rowOps<RecRow>(setReclosers)
  const xfmrOps = rowOps<XfmrRow>(setTransformers)
  const fbOps = rowOps<FbRow>(setFeedersBreakers)
  const setRec = recOps.patch
  const setXfmr = xfmrOps.patch
  const setFb = fbOps.patch
  const setRecSource = (i: number, s: number, patch: Partial<SourceRow>) =>
    setReclosers((rows) => rows.map((r, idx) => (idx === i
      ? { ...r, sources: r.sources.map((src, j) => (j === s ? { ...src, ...patch } : src)) } : r)))

  // The filled-in rows: what gets counted, and what gets sent — one definition
  // of "this row describes a device", so the two can't drift.
  const recRows = reclosers.filter((r) => r.number.trim())
  const xfmrRows = transformers.filter((x) => x.substation.trim() && x.transformer.trim())
  const fbRows = feedersBreakers.filter((f) => f.number.trim())
  const deviceCount = recRows.length + xfmrRows.length + fbRows.length
  const ready = selectedPath !== '' && deviceCount > 0 && !generating

  const saveRun = async () => {
    if (!result) return
    setSaving(true)
    setError(null)
    try {
      const { placed } = await saveDacInitRun(generatedFrom.current, result.run)
      setSaved(placed)
      window.dispatchEvent(new Event(FILES_CHANGED_EVENT))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const generate = async (overwriteNames: string[] = []) => {
    setError(null)
    setResult(null)
    setOverwrite([])
    setSaved(null)
    generatedFrom.current = formProject
    try {
      const { job: id } = await generateDacInit(formProject, {
        path: selectedPath,
        params: { ...params },
        overwrite: overwriteNames,
        reclosers: recRows.map((r) => ({
          number: r.number.trim(),
          switch: r.isSwitch,
          commFail: false,
          normallyOpen: r.normallyOpen,
          capacity: r.capacity.trim(),
          sideAPtSet: params.ptA,
          sideBPtSet: params.ptB,
          sources: r.sources.map((s) => ({ feeder: s.feeder.trim(), sg: s.sg.trim() || '0' })),
          numBi: params.numBi, numAi: params.numAi, numBo: params.numBo,
          numAo: params.numAo, numCnt: params.numCnt,
          circuit: r.circuit.trim(),
        })),
        transformers: xfmrRows.map((x) => ({
          substation: x.substation.trim(),
          transformer: x.transformer.trim(),
          ratedMva: Number(x.ratedMva) || 0,
          dnpClient: x.dnpClient.trim(),
        })),
        feedersBreakers: fbRows.map((f) => ({
          number: f.number.trim(),
          capacity: f.capacity.trim(),
          normallyOpen: f.normallyOpen,
          downstream: f.downstream,
          dnpClient: f.dnpClient.trim(),
        })),
      })
      start(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const summarize = (byKind: Record<string, string[]>) => Object.entries(byKind)
    .filter(([, list]) => list.length)
    .map(([kind, list]) => `${kind}: ${list.join(', ')}`)
    .join(' · ')
  const addedSummary = result ? summarize(result.added) : ''
  const replacedSummary = result ? summarize(result.replaced) : ''
  const alreadyDeclared = result?.declarations.skipped ?? []
  const toggleOverwrite = (name: string) => setOverwrite((names) => (
    names.includes(name) ? names.filter((n) => n !== name) : [...names, name]
  ))

  const saveButton = (
    <Button variant="primary" disabled={saving || saved !== null} onClick={saveRun}>
      {saving ? <Spinner /> : saved ? 'Saved' : `Save new version to ${generatedFrom.current}`}
    </Button>
  )

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>CLECO DAC Inits</h2>
          {generating && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <SectionHeader title="Project" />
        <div className="tool-row" onFocusCapture={() => formProject && loadEntries(formProject)}>
          <Select
            label="Project"
            value={formProject}
            options={projects.length ? projects : [formProject].filter(Boolean)}
            onChange={(name) => name && setFormProject(name)}
          />
          <Select
            label="DAC .rtac"
            value={selectedPath}
            options={rtacEntries.length ? rtacEntries : ['']}
            onChange={setSelectedPath}
          />
        </div>
        {rtacEntries.length === 0 && (
          <div className="tool-stats">No RTAC projects in {formProject}</div>
        )}

        <SectionHeader title="Parameters" />
        {PARAM_ROWS.map((row, r) => (
          <div key={r} className="tool-row dacinit-params">
            {r === 0 && (
              <Select label="Voltage" value={params.voltage} options={['13.2kV', '34.5kV']}
                onChange={(v) => setParam({ voltage: v })} />
            )}
            {row.map(([key, caption]) => (
              <label key={key} className="dacinit-field"><span>{caption}</span>
                <TextInput value={params[key]} onChange={(e) => setParam({ [key]: e.target.value })} /></label>
            ))}
          </div>
        ))}

        <SectionHeader title="Reclosers" count={reclosers.length || undefined} />
        {reclosers.map((r, i) => (
          <div key={i} className="dacinit-card">
            <div className="dacinit-card-row">
              <label className="dacinit-field"><span>Number</span>
                <TextInput value={r.number} placeholder="048" onChange={(e) => setRec(i, { number: e.target.value })} /></label>
              <label className="dacinit-field"><span>Capacity</span>
                <TextInput value={r.capacity} placeholder="105" onChange={(e) => setRec(i, { capacity: e.target.value })} /></label>
              <label className="dacinit-check"><Checkbox checked={r.isSwitch} onChange={() => setRec(i, { isSwitch: !r.isSwitch })} /> Switch</label>
              <label className="dacinit-check"><Checkbox checked={r.normallyOpen} onChange={() => setRec(i, { normallyOpen: !r.normallyOpen })} /> Normally open</label>
              <label className="dacinit-field dacinit-grow"><span>Circuit (comment)</span>
                <TextInput value={r.circuit} onChange={(e) => setRec(i, { circuit: e.target.value })} /></label>
              <Button title="Remove recloser" onClick={() => recOps.remove(i)}>✕</Button>
            </div>
            <div className="dacinit-sources">
              {r.sources.map((src, s) => (
                <Fragment key={s}>
                  <TextInput value={src.feeder} placeholder={`SRC ${String.fromCharCode(65 + s)}`}
                    onChange={(e) => setRecSource(i, s, { feeder: e.target.value })} />
                  <TextInput value={src.sg} placeholder="SG"
                    onChange={(e) => setRecSource(i, s, { sg: e.target.value })} />
                </Fragment>
              ))}
            </div>
          </div>
        ))}
        <div className="tool-row">
          <Button onClick={() => setReclosers((rows) => [...rows, newRec()])}>+ Recloser</Button>
        </div>

        <SectionHeader title="Transformers" count={transformers.length || undefined} />
        {transformers.length > 0 && (
          <div className="dacinit-grid dacinit-xfmr">
            <span className="dacinit-col">Substation</span>
            <span className="dacinit-col">Transformer</span>
            <span className="dacinit-col">Rated MVA</span>
            <span className="dacinit-col">DNP client</span>
            <span />
            {transformers.map((x, i) => (
              <Fragment key={i}>
                <TextInput value={x.substation} placeholder="Goodbee" onChange={(e) => setXfmr(i, { substation: e.target.value })} />
                <TextInput value={x.transformer} placeholder="T1" onChange={(e) => setXfmr(i, { transformer: e.target.value })} />
                <TextInput value={x.ratedMva} placeholder="14" onChange={(e) => setXfmr(i, { ratedMva: e.target.value })} />
                <TextInput value={x.dnpClient} placeholder="Goodbee_Sub" onChange={(e) => setXfmr(i, { dnpClient: e.target.value })} />
                <Button title="Remove transformer" onClick={() => xfmrOps.remove(i)}>✕</Button>
              </Fragment>
            ))}
          </div>
        )}
        <div className="tool-row">
          <Button onClick={() => setTransformers((rows) => [...rows, newXfmr()])}>+ Transformer</Button>
        </div>

        <SectionHeader title="Feeders / Breakers" count={feedersBreakers.length || undefined} />
        {feedersBreakers.length > 0 && (
          <div className="dacinit-grid dacinit-fb">
            <span className="dacinit-col">Number</span>
            <span className="dacinit-col">Capacity</span>
            <span className="dacinit-col">DNP client</span>
            <span className="dacinit-col">Norm. open</span>
            <span className="dacinit-col">Downstream</span>
            <span />
            {feedersBreakers.map((f, i) => (
              <Fragment key={i}>
                <TextInput value={f.number} placeholder="4473A" onChange={(e) => setFb(i, { number: e.target.value })} />
                <TextInput value={f.capacity} placeholder="500" onChange={(e) => setFb(i, { capacity: e.target.value })} />
                <TextInput value={f.dnpClient} placeholder="Goodbee_Sub" onChange={(e) => setFb(i, { dnpClient: e.target.value })} />
                <div className="dacinit-cell-check"><Checkbox checked={f.normallyOpen} onChange={() => setFb(i, { normallyOpen: !f.normallyOpen })} /></div>
                <div className="dacinit-cell-check"><Checkbox checked={f.downstream} onChange={() => setFb(i, { downstream: !f.downstream })} /></div>
                <Button title="Remove" onClick={() => fbOps.remove(i)}>✕</Button>
              </Fragment>
            ))}
          </div>
        )}
        <div className="tool-row">
          <Button onClick={() => setFeedersBreakers((rows) => [...rows, newFb()])}>+ Feeder / Breaker</Button>
        </div>

        <div className="tool-row">
          <Button variant="primary" disabled={!ready} onClick={() => generate()}>
            Generate inits
          </Button>
          <span className="tool-stats">
            {deviceCount} device{deviceCount === 1 ? '' : 's'} → {selectedPath || '(pick a project)'}
          </span>
        </div>

        {error && <div className="tool-error">{error}</div>}

        {job && (
          <div className="tool-joblog">
            {job.log.slice(-10).map((entry, i) => (
              <div key={i} className="tool-joblog-line">{entry}</div>
            ))}
          </div>
        )}

        {result && result.conflicts.length > 0 && (
          <div className="dacinit-conflicts">
            <div className="dacinit-conflicts-head">
              Already initialized in {result.entryName}, and left untouched. Check any you
              meant to change — each is regenerated with the parameters above, in place,
              where it already sits.
            </div>
            <div className="dacinit-conflicts-list">
              {result.conflicts.map((conflict) => (
                <label key={conflict.name} className="dacinit-check">
                  <Checkbox
                    checked={overwrite.includes(conflict.name)}
                    onChange={() => toggleOverwrite(conflict.name)}
                  />
                  {conflict.name}
                  <span className="dacinit-conflicts-where">in {conflict.where.join(', ')}</span>
                </label>
              ))}
            </div>
            <div className="tool-row">
              <Button
                variant="primary"
                disabled={overwrite.length === 0 || generating}
                onClick={() => generate(overwrite)}
              >
                Overwrite {overwrite.length} &amp; regenerate
              </Button>
              <span className="tool-stats">Declarations stay as they are — a VAR_GLOBAL line carries only the device type.</span>
            </div>
          </div>
        )}

        {result && (
          <RunOutputs
            tool="dacinit"
            run={result.run}
            reports={result.reports}
            downloadOnly
            rowActions={() => saveButton}
          >
            {addedSummary && (
              <div className="tool-row"><span className="tool-stats">Will add — {addedSummary}</span></div>
            )}
            {replacedSummary && (
              <div className="tool-row"><span className="tool-stats">Will overwrite in place — {replacedSummary}</span></div>
            )}
            {alreadyDeclared.length > 0 && (
              <div className="tool-row"><span className="tool-stats">Already declared: {alreadyDeclared.join(', ')}</span></div>
            )}
            {!result.changed && (
              <div className="tool-row"><span className="tool-stats">Nothing to save — every device you listed is already in this project.</span></div>
            )}
            {result.changed > 0 && result.reports.length === 0 && <div className="tool-row">{saveButton}</div>}
            {saved && (
              <div className="tool-row">
                <span className="tool-stats">Saved new version: {saved} — “{result.note}”</span>
              </div>
            )}
          </RunOutputs>
        )}
      </div>
    </>
  )
}
