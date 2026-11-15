// CLECO DAC Inits — the projector-native replacement for the "DAC Inits"
// workbook + copy/paste. Drag a DAC .rtac in from the project tree, describe the
// devices you're adding (reclosers, transformers, feeders/breakers,
// connectors), and the
// backend generates the same Structured-Text init blocks the macro did,
// appends them to the project's Init_* POUs, and — on the explicit Save —
// lands the result as a NEW VERSION of that .rtac entry (note "Auto-add
// inits"). Nothing touches the tree until Save.
//
// Pointers, definitions and point counts come from the dropped project itself
// (its DNP clients, SCADA maps and device definitions), so there is nothing
// project-wide to fill in. Anything the project couldn't answer comes back as a warning
// naming the line that was written by convention instead.
//
// A recloser the DAC already has is an UPDATE: typing its number fills in its
// current capacity, switch mode and settings-group sources from the project,
// and generate rewrites just those settings in its block, where it sits — the
// common case of a scheme addition re-rating, re-moding or re-sourcing
// existing reclosers. Its other fields don't apply and are disabled.
//
// New devices are wired into the rest of the scheme in the same run: each
// gets a SCADA map block copied from a like device, a
// recloser goes onto the AreaMap between its A-side and B-side devices (B
// side blank = whatever the A side feeds now), a new feeder and its breaker
// on a new AreaMap row, a recloser on its own client gets its fault-current
// block, Fault_Data tags and Tag Processor rows, and a new 13.2kV feeder with
// nothing downline is added to Feeders_Excluded. A connector feeds the tie it
// names on the AreaMap, on the manager for its remote DAC (a new one, with its
// port and IP variables, when the DAC has none for that remote yet).
//
// Any other identifier the project already uses isn't quietly skipped:
// generate comes back with it flagged, and the warning below offers to overwrite — which
// regenerates that device's init block where it already sits (so a changed
// capacity is an edit, not a second block at the bottom of the POU). Choosing
// overwrite just re-runs generate with those names; nothing lands until Save.

import { Fragment, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

import { generateDacInit, lookupDacInit, saveDacInitRun } from '../api'
import { Button, Checkbox, DropZone, SectionHeader, Select, Spinner, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { useToolJob } from '../lib/useToolJob'
import type { DacInitExisting, DacInitResult } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'
import { ToolHeader } from './ToolHeader'

const SOURCE_SLOTS = 6

const BREAKERS = [
  { value: '651R', label: '651R' }, { value: '351R', label: '351R' },
  { value: 'pseudo', label: 'Pseudo' }, { value: 'none', label: 'None' },
]
// What a feeder's breaker is unless you say: the schemes' own rule.
const defaultBreaker = (family: string) => (family === '34.5kV' ? 'pseudo' : '651R')
// Result keys -> what a person calls them.
const KIND_LABELS: Record<string, string> = {
  reclosers: 'reclosers', transformers: 'transformers', feeders: 'feeders',
  breakers: 'breakers', pseudoBreakers: 'pseudo breakers', connectors: 'connectors',
}

interface SourceRow { feeder: string; sg: string }
interface RecRow {
  number: string
  isSwitch: boolean
  commFail: boolean
  normallyOpen: boolean
  capacity: string
  circuit: string
  aSide: string
  bSide: string
  sources: SourceRow[]
}
interface XfmrRow { substation: string; transformer: string; ratedMva: string; dnpClient: string }
interface FbRow {
  number: string; capacity: string; normallyOpen: boolean; breaker: string; lockout: string; dnpClient: string; aSide: string
}
interface ConnRow { connection: string; remoteDac: string; feeds: string; port: string; remoteIp: string }

const emptySources = (): SourceRow[] =>
  Array.from({ length: SOURCE_SLOTS }, () => ({ feeder: '', sg: '0' }))
const newRec = (): RecRow => ({
  number: '', isSwitch: false, commFail: false, normallyOpen: false, capacity: '', circuit: '',
  aSide: '', bSide: '', sources: emptySources(),
})
const newXfmr = (): XfmrRow => ({ substation: '', transformer: '', ratedMva: '', dnpClient: '' })
const newFb = (breaker: string): FbRow => ({ number: '', capacity: '', normallyOpen: false, breaker, lockout: '', dnpClient: '', aSide: '' })
const newConn = (): ConnRow => ({ connection: '', remoteDac: '', feeds: '', port: '', remoteIp: '' })

export function DacInitTool(_props: ToolProps) {
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

  // The DAC .rtac dragged in from the tree, and the project it came from.
  const [formProject, setFormProject] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [reclosers, setReclosers] = useState<RecRow[]>([])
  const [transformers, setTransformers] = useState<XfmrRow[]>([])
  const [feedersBreakers, setFeedersBreakers] = useState<FbRow[]>([])
  const [connectors, setConnectors] = useState<ConnRow[]>([])

  // The reclosers the dropped DAC already has, keyed by lowercased name.
  const [existing, setExisting] = useState<Map<string, DacInitExisting>>(new Map())
  // Its voltage and the remote DACs it already has managers for.
  const [family, setFamily] = useState('')
  const [remotes, setRemotes] = useState<string[]>([])
  useEffect(() => {
    setExisting(new Map())
    setFamily('')
    setRemotes([])
    if (!selectedPath) return
    let live = true
    lookupDacInit(formProject, selectedPath)
      .then(({ reclosers: found, family: fam, remotes: known }) => {
        if (!live) return
        setExisting(new Map(found.map((r) => [r.name.toLowerCase(), r])))
        setFamily(fam)
        setRemotes(known)
      })
      .catch((err) => { if (live) setError(errorMessage(err)) })
    return () => { live = false }
  }, [formProject, selectedPath])
  const existingRec = (number: string) => existing.get(`r${number.trim().toLowerCase()}`)
  // Typing an existing recloser's number fills in what it has now. Sources
  // show the way they're typed: a feeder by its number, anything else by name.
  const setRecNumber = (i: number, number: string) => {
    const found = existingRec(number)
    if (!found) { setRec(i, { number }); return }
    const sources = found.sources
      ? found.sources.map(({ src, sg }) => ({
        feeder: src === '0' ? '' : src.replace(/\.ID$/i, '').replace(/^F(?=\d)/i, ''),
        sg,
      }))
      : emptySources()
    setRec(i, { number, capacity: found.capacity ?? '', isSwitch: found.switchMode, sources })
  }

  // "Save to project": the project the run was configured from, captured at
  // generate so dropping another DAC afterwards cannot misplace it.
  const generatedFrom = useRef('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  // Patch/remove one row of a device table — the same two lines for all three.
  const rowOps = <T,>(setRows: Dispatch<SetStateAction<T[]>>) => ({
    patch: (i: number, patch: Partial<T>) =>
      setRows((rows) => rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row))),
    remove: (i: number) => setRows((rows) => rows.filter((_, idx) => idx !== i)),
  })
  const recOps = rowOps<RecRow>(setReclosers)
  const xfmrOps = rowOps<XfmrRow>(setTransformers)
  const fbOps = rowOps<FbRow>(setFeedersBreakers)
  const connOps = rowOps<ConnRow>(setConnectors)
  const setConn = connOps.patch
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
  const connRows = connectors.filter((c) => c.feeds.trim())
  const isNewRemote = (c: ConnRow) => c.remoteDac.trim() !== ''
    && !remotes.some((r) => r.toLowerCase() === c.remoteDac.trim().toLowerCase())
  const wantsName = family === '13.2kV'
  const deviceCount = recRows.length + xfmrRows.length + fbRows.length + connRows.length
  const ready = selectedPath !== '' && deviceCount > 0 && !generating

  const saveRun = async () => {
    if (!result) return
    setSaving(true)
    setError(null)
    try {
      const { placed } = await saveDacInitRun(generatedFrom.current, result.run)
      setSaved(placed)
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
        params: {},
        overwrite: overwriteNames,
        reclosers: recRows.map((r) => ({
          number: r.number.trim(),
          switch: r.isSwitch,
          commFail: r.commFail,
          normallyOpen: r.normallyOpen,
          capacity: r.capacity.trim(),
          sources: r.sources.map((s) => ({ feeder: s.feeder.trim(), sg: s.sg.trim() || '0' })),
          circuit: r.circuit.trim(),
          aSide: r.aSide.trim(),
          bSide: r.bSide.trim(),
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
          breaker: f.breaker,
          lockout: f.lockout.trim(),
          dnpClient: f.dnpClient.trim(),
          aSide: f.aSide.trim(),
        })),
        connectors: connRows.map((c) => ({
          connection: wantsName ? c.connection.trim() : '',
          remoteDac: c.remoteDac.trim(),
          feeds: c.feeds.trim(),
          port: isNewRemote(c) ? c.port.trim() : '',
          remoteIp: isNewRemote(c) ? c.remoteIp.trim() : '',
        })),
      })
      start(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const summarize = (byKind: Record<string, string[]>) => Object.entries(byKind)
    .filter(([, list]) => list.length)
    .map(([kind, list]) => `${KIND_LABELS[kind] ?? kind}: ${list.join(', ')}`)
    .join(' · ')
  const addedSummary = result ? summarize(result.added) : ''
  const replacedSummary = result ? summarize(result.replaced) : ''
  const updatedSummary = (result?.updated ?? []).map((u) => `${u.name}: ${u.changes
    .map((c) => `${c.what} ${c.from ?? '—'} → ${c.to}`).join(', ')}`).join(' · ')
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
      <ToolHeader title="CLECO DAC Inits" busy={generating} />
      <div className="tool-scroll">
        <SectionHeader title="DAC" />
        {selectedPath ? (
          <div className="tool-row">
            <span className="tool-stats">{selectedPath} (from {formProject})</span>
            <Button disabled={generating} onClick={() => setSelectedPath('')}>Change</Button>
          </div>
        ) : (
          <DropZone
            extensions={['.rtac']}
            onEntries={(fromProject, [path]) => {
              setFormProject(fromProject)
              setSelectedPath(path)
            }}
            disabled={generating}
          >
            <b>Drop the DAC .rtac here</b>
            from the project tree
          </DropZone>
        )}


        <SectionHeader title="Reclosers" count={reclosers.length || undefined} />
        {reclosers.map((r, i) => {
          const update = !!existingRec(r.number)
          return (
          <div key={i} className="dacinit-card">
            <div className="dacinit-card-row">
              <label className="dacinit-field"><span>Number</span>
                <TextInput value={r.number} placeholder="048" onChange={(e) => setRecNumber(i, e.target.value)} /></label>
              <label className="dacinit-field"><span>Capacity</span>
                <TextInput value={r.capacity} placeholder="105" onChange={(e) => setRec(i, { capacity: e.target.value })} /></label>
              <label className="dacinit-check"><Checkbox checked={r.isSwitch} onChange={() => setRec(i, { isSwitch: !r.isSwitch })} /> Switch</label>
              <label className="dacinit-check"><Checkbox checked={r.commFail} disabled={update} onChange={() => setRec(i, { commFail: !r.commFail })} /> Comm fail</label>
              <label className="dacinit-check"><Checkbox checked={r.normallyOpen} disabled={update} onChange={() => setRec(i, { normallyOpen: !r.normallyOpen })} /> Normally open</label>
              <label className="dacinit-field dacinit-grow"><span>Circuit (comment)</span>
                <TextInput value={r.circuit} disabled={update} onChange={(e) => setRec(i, { circuit: e.target.value })} /></label>
              <label className="dacinit-field"><span>A side</span>
                <TextInput value={r.aSide} placeholder="B6310" disabled={update} onChange={(e) => setRec(i, { aSide: e.target.value })} /></label>
              <label className="dacinit-field"><span>B side</span>
                <TextInput value={r.bSide} disabled={update} onChange={(e) => setRec(i, { bSide: e.target.value })} /></label>
              {update && <span className="dacinit-existing">Updates R{r.number.trim()}</span>}
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
          )
        })}
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
            <span className="dacinit-col">A side</span>
            <span className="dacinit-col">Norm. open</span>
            <span className="dacinit-col">Breaker</span>
            <span className="dacinit-col">Lockout</span>
            <span />
            {feedersBreakers.map((f, i) => (
              <Fragment key={i}>
                <TextInput value={f.number} placeholder="4473A" onChange={(e) => setFb(i, { number: e.target.value })} />
                <TextInput value={f.capacity} placeholder="500" onChange={(e) => setFb(i, { capacity: e.target.value })} />
                <TextInput value={f.dnpClient} placeholder="Goodbee_Sub" onChange={(e) => setFb(i, { dnpClient: e.target.value })} />
                <TextInput value={f.aSide} placeholder="XFMR_Goodbee_T1" onChange={(e) => setFb(i, { aSide: e.target.value })} />
                <div className="dacinit-cell-check"><Checkbox checked={f.normallyOpen} onChange={() => setFb(i, { normallyOpen: !f.normallyOpen })} /></div>
                <Select value={f.breaker} options={BREAKERS} onChange={(v) => setFb(i, { breaker: v })} />
                <TextInput value={f.lockout} placeholder="15s" disabled={f.breaker !== 'pseudo'}
                  onChange={(e) => setFb(i, { lockout: e.target.value })} />
                <Button title="Remove" onClick={() => fbOps.remove(i)}>✕</Button>
              </Fragment>
            ))}
          </div>
        )}
        <div className="tool-row">
          <Button onClick={() => setFeedersBreakers((rows) => [...rows, newFb(defaultBreaker(family))])}>+ Feeder / Breaker</Button>
        </div>

        <SectionHeader title="Connectors" count={connectors.length || undefined} />
        {connectors.length > 0 && (
          <div className={`dacinit-grid dacinit-conn${wantsName ? ' dacinit-conn-named' : ''}`}>
            <span className="dacinit-col">Feeds</span>
            <span className="dacinit-col">Remote DAC</span>
            {wantsName && <span className="dacinit-col">Name</span>}
            <span className="dacinit-col">{connectors.some(isNewRemote) ? 'Port' : ''}</span>
            <span className="dacinit-col">{connectors.some(isNewRemote) ? 'Remote IP' : ''}</span>
            <span />
            {connectors.map((c, i) => (
              <Fragment key={i}>
                <TextInput value={c.feeds} placeholder="R6315" onChange={(e) => setConn(i, { feeds: e.target.value })} />
                <TextInput value={c.remoteDac} placeholder={remotes[0] ?? 'Eunice'} onChange={(e) => setConn(i, { remoteDac: e.target.value })} />
                {wantsName && <TextInput value={c.connection} placeholder="6421A_6404B" onChange={(e) => setConn(i, { connection: e.target.value })} />}
                {isNewRemote(c) ? <TextInput value={c.port} placeholder="59056" onChange={(e) => setConn(i, { port: e.target.value })} /> : <span />}
                {isNewRemote(c) ? <TextInput value={c.remoteIp} placeholder="192.168.199.22" onChange={(e) => setConn(i, { remoteIp: e.target.value })} /> : <span />}
                <Button title="Remove" onClick={() => connOps.remove(i)}>✕</Button>
              </Fragment>
            ))}
          </div>
        )}
        <div className="tool-row">
          <Button onClick={() => setConnectors((rows) => [...rows, newConn()])}>+ Connector</Button>
        </div>

        <div className="tool-row">
          <Button variant="primary" disabled={!ready} onClick={() => generate()}>
            Generate
          </Button>
          <span className="tool-stats">
            {deviceCount} device{deviceCount === 1 ? '' : 's'} → {selectedPath || '(drop a DAC)'}
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

        {result && result.warnings.length > 0 && (
          <div className="dacinit-conflicts">
            <div className="dacinit-conflicts-head">Warnings</div>
            <div className="dacinit-warnings">
              {result.warnings.map((w, i) => (
                <div key={i}><b>{w.device}</b> {w.message}</div>
              ))}
            </div>
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
            <div className="tool-row"><span className="tool-stats">{result.family} scheme</span></div>
            {addedSummary && (
              <div className="tool-row"><span className="tool-stats">Will add — {addedSummary}</span></div>
            )}
            {updatedSummary && (
              <div className="tool-row"><span className="tool-stats">Will update in place — {updatedSummary}</span></div>
            )}
            {result.unchanged.length > 0 && (
              <div className="tool-row"><span className="tool-stats">Already as listed: {result.unchanged.join(', ')}</span></div>
            )}
            {replacedSummary && (
              <div className="tool-row"><span className="tool-stats">Will overwrite in place — {replacedSummary}</span></div>
            )}
            {result.wired.scada.length > 0 && (
              <div className="tool-row"><span className="tool-stats">SCADA map — {result.wired.scada
                .map((s) => `${s.group} from ${s.template}`).join(' · ')}</span></div>
            )}
            {result.wired.areaMap.length > 0 && (
              <div className="tool-row"><span className="tool-stats">AreaMap — {result.wired.areaMap
                .map((p) => `${p.name} ${p.where}`).join(' · ')}</span></div>
            )}
            {result.wired.faults.length > 0 && (
              <div className="tool-row"><span className="tool-stats">Fault logic — {result.wired.faults
                .map((f) => `${f.name} in ${f.program}${f.created ? ' (new)' : ''}`).join(' · ')}</span></div>
            )}
            {result.wired.excluded.length > 0 && (
              <div className="tool-row"><span className="tool-stats">Feeders_Excluded — {result.wired.excluded.join(', ')}</span></div>
            )}
            {alreadyDeclared.length > 0 && (
              <div className="tool-row"><span className="tool-stats">Already declared: {alreadyDeclared.join(', ')}</span></div>
            )}
            {!result.changed && (
              <div className="tool-row"><span className="tool-stats">Nothing new to save.</span></div>
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
