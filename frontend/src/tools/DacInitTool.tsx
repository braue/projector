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
// recloser goes onto the AreaMap after its one A side, in front of each B
// side listed (a comma list takes over several of the A side's branches;
// "none" ends the line; B side is never guessed), a new feeder and its breaker
// on a new AreaMap row, a recloser on its own client gets its fault-current
// block, Fault_Data tags and Tag Processor rows, and a new 13.2kV feeder with
// nothing downline is added to Feeders_Excluded. A connector feeds the tie it
// names on the AreaMap, on the manager for its remote DAC (a new one, with its
// port and IP variables, when the DAC has none for that remote yet).
//
// The form names things the way the project does. A device's own number sits
// after its fixed letter (R, F, XFMR_…), so "6267" and "R6267" both mean
// R6267. Every field that points at another device (A side, B side, a
// source, the tie a connector feeds) takes that device's full name, and
// offers the AreaMap's names and the form's own new rows; a name that's in
// neither is outlined red before generate ever runs. Each card draws where
// its device lands (A side → R6267 → B side) so the wiring reads at a glance.
//
// Any other identifier the project already uses isn't quietly skipped:
// generate comes back with it flagged, and the warning below offers to overwrite — which
// regenerates that device's init block where it already sits (so a changed
// capacity is an edit, not a second block at the bottom of the POU). Choosing
// overwrite just re-runs generate with those names; nothing lands until Save.

import { useEffect, useRef, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'

import { generateDacInit, lookupDacInit, saveDacInitRun } from '../api'
import { Button, Checkbox, DropZone, SectionHeader, Select, Spinner } from '../components/ui'
import { errorMessage } from '../lib/errors'
import { useToolJob } from '../lib/useToolJob'
import type { DacInitExisting, DacInitLookup, DacInitResult } from '../types'
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
interface XfmrRow { substation: string; transformer: string; ratedMva: string }
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
const newXfmr = (): XfmrRow => ({ substation: '', transformer: '', ratedMva: '' })
const newFb = (breaker: string): FbRow => ({ number: '', capacity: '', normallyOpen: false, breaker, lockout: '', dnpClient: '', aSide: '' })
const newConn = (): ConnRow => ({ connection: '', remoteDac: '', feeds: '', port: '', remoteIp: '' })

const NO_LOOKUP: DacInitLookup = { family: '', reclosers: [], remotes: [], areaMap: [], clients: [] }
const lower = (s: string) => s.trim().toLowerCase()
const splitList = (v: string) => v.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
// The client a transformer reports through, found by its substation's name
// the way the backend finds it (substationClient in dacinit/project.js).
const substationClients = (clients: string[], substation: string) => {
  const key = substation.trim().replace(/\s+/g, '_').toLowerCase()
  if (!key) return []
  let found = clients.filter((c) => c.toLowerCase().includes(key))
  for (const narrow of [(n: string) => /(^|_)sub(_|$)/i.test(n), (n: string) => !/\d{3,}/.test(n)]) {
    if (found.length > 1 && found.some(narrow)) found = found.filter(narrow)
  }
  return found
}
const xfmrName = (x: XfmrRow) => `XFMR_${x.substation.trim().replace(/\s+/g, '_')}_${x.transformer.trim()}`
// The identifier a connector row lands as (the backend's connectorName).
const connName = (c: ConnRow) => {
  const n = /(\d+[A-Za-z]?)/.exec(c.feeds)?.[1]
  return n ? `R${n}_Connector` : ''
}

/** A device's own number after its fixed letter: "R6267" typed or pasted is 6267. */
function IdInput({ prefix, value, onChange, placeholder, strip, wide }: {
  prefix: string; value: string; onChange: (v: string) => void; placeholder?: string; strip?: RegExp; wide?: boolean
}) {
  return (
    <span className={`dacinit-id${wide ? ' dacinit-id-wide' : ''}`}>
      <span className="dacinit-id-prefix">{prefix}</span>
      <input value={value} placeholder={placeholder} spellCheck={false}
        onChange={(e) => onChange(strip ? e.target.value.replace(strip, '') : e.target.value)} />
    </span>
  )
}

/**
 * A field naming another device by its full name (or a comma list of them).
 * Offers `names`; outlines a name that isn't one of them, or whatever
 * `problem` says is wrong; and on blur completes each bare number to the one
 * name it can only mean ("6310" -> "B6310").
 */
function RefInput({ value, onChange, names, list, placeholder, unknownTitle = 'Not on the AreaMap', strict = true, problem }: {
  value: string; onChange: (v: string) => void; names: string[]; list: string; placeholder?: string
  unknownTitle?: string; strict?: boolean; problem?: string | null
}) {
  const v = lower(value)
  const unknown = problem !== undefined
    ? problem
    : strict && v !== '' && v !== '0' && !names.some((n) => lower(n) === v) ? unknownTitle : null
  const completeOne = (token: string) => {
    if (!/^\d+[a-z]?$/i.test(token)) return token
    const hits = names.filter((n) => new RegExp(`^[a-z]+_?${token}$`, 'i').test(n))
    return hits.length === 1 ? hits[0] : token
  }
  // Only a list's own commas split it: a name with a space ("St Mary") stays whole.
  const complete = () => {
    const tokens = value.split(',').map((t) => t.trim())
    const done = tokens.map(completeOne)
    if (done.some((t, i) => t !== tokens[i])) onChange(done.filter(Boolean).join(', '))
  }
  return (
    <input type="text" className={`ui-input dacinit-ref${unknown ? ' is-unknown' : ''}`} list={list}
      value={value} placeholder={placeholder} spellCheck={false} title={unknown ?? undefined}
      onChange={(e) => onChange(e.target.value)} onBlur={complete} />
  )
}

function Field({ label, unit, children, grow }: { label: string; unit?: string; children: ReactNode; grow?: boolean }) {
  return (
    <label className={`dacinit-field${grow ? ' dacinit-grow' : ''}`}>
      <span>{label}</span>
      {unit ? <span className="dacinit-unit">{children}<i>{unit}</i></span> : children}
    </label>
  )
}

/** Where the device lands: its neighbours either side of it. */
function Flow({ label = 'AreaMap', children }: { label?: string; children: ReactNode }) {
  return (
    <div className="dacinit-flow">
      <span className="dacinit-flow-label">{label}</span>
      {children}
    </div>
  )
}
const Arrow = ({ back }: { back?: boolean }) => <span className="dacinit-arrow">{back ? '←' : '→'}</span>
const Self = ({ name }: { name: string }) => <span className="dacinit-self">{name || '…'}</span>

function CardHead({ kind, children, onRemove }: { kind: string; children: ReactNode; onRemove: () => void }) {
  return (
    <div className="dacinit-card-head">
      <span className="dacinit-kind">{kind}</span>
      {children}
      <span className="dacinit-spacer" />
      <button type="button" className="dacinit-remove" title="Remove" onClick={onRemove}>✕</button>
    </div>
  )
}
const Chip = ({ tone, children }: { tone: 'new' | 'update' | 'exists'; children: ReactNode }) =>
  <span className={`dacinit-chip dacinit-chip-${tone}`}>{children}</span>

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

  // What the dropped DAC already has: its reclosers' settings (keyed by
  // lowercased name), voltage, remote DACs, AreaMap names and DNP clients.
  const [lookup, setLookup] = useState<DacInitLookup>(NO_LOOKUP)
  const [existing, setExisting] = useState<Map<string, DacInitExisting>>(new Map())
  useEffect(() => {
    setLookup(NO_LOOKUP)
    setExisting(new Map())
    if (!selectedPath) return
    let live = true
    lookupDacInit(formProject, selectedPath)
      .then((found) => {
        if (!live) return
        setLookup(found)
        setExisting(new Map(found.reclosers.map((r) => [r.name.toLowerCase(), r])))
      })
      .catch((err) => { if (live) setError(errorMessage(err)) })
    return () => { live = false }
  }, [formProject, selectedPath])
  const { family, remotes, clients } = lookup
  const existingRec = (number: string) => (number.trim() ? existing.get(`r${lower(number)}`) : undefined)
  // Typing an existing recloser's number fills in what it has now.
  const setRecNumber = (i: number, number: string) => {
    const found = existingRec(number)
    if (!found) { setRec(i, { number }); return }
    const sources = found.sources
      ? found.sources.map(({ src, sg }) => ({ feeder: src === '0' ? '' : src.replace(/\.ID$/i, ''), sg }))
      : emptySources()
    setRec(i, { number, capacity: found.capacity ?? '', isSwitch: found.switchMode, sources })
  }

  // "Save to project": the project the run was configured from, captured at
  // generate so dropping another DAC afterwards cannot misplace it.
  const generatedFrom = useRef('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)

  // Patch/remove one row of a device table — the same two lines for all four.
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
    && !remotes.some((r) => lower(r) === lower(c.remoteDac))
  const wantsName = family === '13.2kV'
  const fed = family !== '34.5kV'
  const deviceCount = recRows.length + xfmrRows.length + fbRows.length + connRows.length

  // Names a reference field can point at: the AreaMap's, plus this form's new rows.
  const onMap = lookup.areaMap.map((b) => b.name)
  const mapKind = (kinds: string[]) => lookup.areaMap.filter((b) => kinds.includes(b.kind)).map((b) => b.name)
  const breakerName = (f: FbRow) => (f.breaker === 'none' || !f.number.trim() ? '' : `B${f.number.trim()}`)
  const newNames = {
    reclosers: recRows.filter((r) => !existingRec(r.number)).map((r) => `R${r.number.trim()}`),
    feeders: fbRows.map((f) => `F${f.number.trim()}`),
    breakers: fbRows.map(breakerName).filter(Boolean),
    transformers: xfmrRows.map(xfmrName),
    connectors: connRows.map(connName).filter(Boolean),
  }
  const unique = (list: string[]) => [...new Map(list.map((n) => [lower(n), n])).values()]
  const allNames = unique([...onMap, ...Object.values(newNames).flat()])
  const sourceNames = unique([...mapKind(['feeder', 'connector']), ...newNames.feeders, ...newNames.connectors])
  const xfmrNames = unique([...mapKind(['transformer']), ...newNames.transformers])
  const tieNames = unique([...mapKind(['recloser']), ...newNames.reclosers])
  const isOnMap = (name: string) => onMap.some((n) => lower(n) === lower(name))
  const isKnown = (name: string) => allNames.some((n) => lower(n) === lower(name))
  // A new recloser's sides: one A side, and a B side that is a list of what
  // the A side feeds now (each must be), or "none". Wiring is only checked
  // between devices already on the AreaMap — a new one has none yet.
  const aSideProblem = (r: RecRow) => {
    if (/,/.test(r.aSide)) return 'One A side'
    if (r.aSide.trim() && !isKnown(r.aSide)) return 'Not on the AreaMap'
    return null
  }
  const bSideProblem = (r: RecRow) => {
    const list = splitList(r.bSide)
    if (!list.length) return null
    if (list.length === 1 && lower(list[0]) === 'none') return null
    if (list.some((n) => lower(n) === 'none')) return 'A list or none, not both'
    if (r.normallyOpen && list.length > 1) return 'A tie has one B side'
    const unknown = list.find((n) => !isKnown(n))
    if (unknown) return `${unknown} is not on the AreaMap`
    const branches = lookup.areaMap.find((b) => lower(b.name) === lower(r.aSide))?.feeds
    if (!r.normallyOpen && branches) {
      const off = list.find((n) => isOnMap(n) && !branches.some((f) => lower(f) === lower(n)))
      if (off) return `${r.aSide.trim()} feeds ${branches.length ? branches.join(', ') : 'nothing'}, not ${off}`
    }
    return null
  }
  const sidesReady = recRows.every((r) => existingRec(r.number)
    || (r.aSide.trim() && r.bSide.trim() && !aSideProblem(r) && !bSideProblem(r)))
  const ready = selectedPath !== '' && deviceCount > 0 && !generating && sidesReady

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
        })),
        feedersBreakers: fbRows.map((f) => ({
          number: f.number.trim(),
          capacity: f.capacity.trim(),
          normallyOpen: f.normallyOpen,
          breaker: f.breaker,
          lockout: f.lockout.trim(),
          dnpClient: f.dnpClient.trim(),
          aSide: fed ? f.aSide.trim() : '',
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
  const summaryRow = (label: string, text: string) => (
    <div className="dacinit-summary-row"><span>{label}</span><span>{text}</span></div>
  )
  const mapCounts = ['recloser', 'feeder', 'transformer', 'connector']
    .map((kind) => [kind, lookup.areaMap.filter((b) => b.kind === kind).length] as const)
    .filter(([, n]) => n > 0)

  return (
    <>
      <ToolHeader title="CLECO DAC Inits" busy={generating} />
      <div className="tool-scroll">
        <datalist id="dacinit-names">{allNames.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="dacinit-sources">{sourceNames.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="dacinit-xfmrs">{xfmrNames.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="dacinit-ties">{tieNames.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="dacinit-clients">{clients.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="dacinit-remotes">{remotes.map((n) => <option key={n} value={n} />)}</datalist>

        <SectionHeader title="DAC" />
        {selectedPath ? (
          <div className="dacinit-dac">
            <span className="dacinit-dac-name">{selectedPath.split('/').pop()}</span>
            <span className="tool-stats">{formProject}</span>
            {family && <Chip tone="exists">{family}</Chip>}
            {mapCounts.map(([kind, n]) => <span key={kind} className="tool-stats">{n} {kind}{n === 1 ? '' : 's'}</span>)}
            <span className="dacinit-spacer" />
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

        <SectionHeader title="Devices" />

        {reclosers.map((r, i) => {
          const found = existingRec(r.number)
          const name = r.number.trim() ? `R${r.number.trim()}` : ''
          return (
            <div key={`r${i}`} className={`dacinit-card${found ? ' dacinit-card-update' : ''}`}>
              <CardHead kind="Recloser" onRemove={() => recOps.remove(i)}>
                <IdInput prefix="R" value={r.number} placeholder="6267" strip={/^\s*r(?=\d)/i}
                  onChange={(v) => setRecNumber(i, v)} />
                {found ? <Chip tone="update">Update</Chip> : name && <Chip tone="new">New</Chip>}
              </CardHead>
              <div className="dacinit-card-row">
                <Field label="Capacity" unit="A">
                  <input className="ui-input" value={r.capacity} placeholder="170"
                    onChange={(e) => setRec(i, { capacity: e.target.value })} />
                </Field>
                <label className="dacinit-check"><Checkbox checked={r.isSwitch} onChange={() => setRec(i, { isSwitch: !r.isSwitch })} /> Switch</label>
                {!found && <>
                  <label className="dacinit-check"><Checkbox checked={r.commFail} onChange={() => setRec(i, { commFail: !r.commFail })} /> Comm fail</label>
                  <label className="dacinit-check"><Checkbox checked={r.normallyOpen} onChange={() => setRec(i, { normallyOpen: !r.normallyOpen })} /> Normally open</label>
                  <Field label="Circuit" grow>
                    <input className="ui-input" value={r.circuit} placeholder="6310"
                      onChange={(e) => setRec(i, { circuit: e.target.value })} />
                  </Field>
                </>}
              </div>
              {!found && (
                <Flow>
                  <RefInput value={r.aSide} names={allNames} list="dacinit-names" placeholder="A side"
                    problem={aSideProblem(r)} onChange={(v) => setRec(i, { aSide: v })} />
                  <Arrow />
                  <Self name={name} />
                  <Arrow back={r.normallyOpen} />
                  <RefInput value={r.bSide} names={allNames} list="dacinit-names" placeholder="B side, or none"
                    problem={bSideProblem(r)} onChange={(v) => setRec(i, { bSide: v })} />
                  {(aSideProblem(r) ?? bSideProblem(r)) && (
                    <span className="dacinit-problem">{aSideProblem(r) ?? bSideProblem(r)}</span>
                  )}
                </Flow>
              )}
              <div className="dacinit-sources">
                <span className="dacinit-flow-label">Sources</span>
                <div className="dacinit-source-grid">
                  {r.sources.map((src, s) => (
                    <div key={s} className="dacinit-source">
                      <span className="dacinit-source-slot">{String.fromCharCode(65 + s)}</span>
                      <RefInput value={src.feeder} names={sourceNames} list="dacinit-sources"
                        unknownTitle="Not a feeder or connector"
                        onChange={(v) => setRecSource(i, s, { feeder: v })} />
                      <IdInput prefix="SG" value={src.sg} onChange={(v) => setRecSource(i, s, { sg: v })} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        })}

        {feedersBreakers.map((f, i) => {
          const name = f.number.trim() ? `F${f.number.trim()}` : ''
          return (
            <div key={`f${i}`} className="dacinit-card">
              <CardHead kind="Feeder" onRemove={() => fbOps.remove(i)}>
                <IdInput prefix="F" value={f.number} placeholder="4473A" strip={/^\s*[fb](?=\d)/i}
                  onChange={(v) => setFb(i, { number: v })} />
                {name && (isOnMap(name) ? <Chip tone="exists">On AreaMap</Chip> : <Chip tone="new">New</Chip>)}
              </CardHead>
              <div className="dacinit-card-row">
                <Field label="Capacity" unit="A">
                  <input className="ui-input" value={f.capacity} placeholder="500"
                    onChange={(e) => setFb(i, { capacity: e.target.value })} />
                </Field>
                <Field label="Breaker">
                  <Select value={f.breaker} options={BREAKERS} onChange={(v) => setFb(i, { breaker: v })} />
                </Field>
                {f.breaker === 'pseudo' && (
                  <Field label="Lockout" unit="s">
                    <input className="ui-input" value={f.lockout} placeholder="15"
                      onChange={(e) => setFb(i, { lockout: e.target.value })} />
                  </Field>
                )}
                <label className="dacinit-check"><Checkbox checked={f.normallyOpen} onChange={() => setFb(i, { normallyOpen: !f.normallyOpen })} /> Normally open</label>
                <Field label="DNP client" grow>
                  <RefInput value={f.dnpClient} names={clients} list="dacinit-clients" placeholder="auto"
                    unknownTitle="No DNP client by that name" onChange={(v) => setFb(i, { dnpClient: v })} />
                </Field>
              </div>
              <Flow>
                {fed && <>
                  <RefInput value={f.aSide} names={xfmrNames} list="dacinit-xfmrs" placeholder="Transformer"
                    onChange={(v) => setFb(i, { aSide: v })} />
                  <Arrow />
                </>}
                <Self name={name} />
                {breakerName(f) && <><Arrow /><Self name={breakerName(f)} /></>}
              </Flow>
            </div>
          )
        })}

        {transformers.map((x, i) => {
          const name = x.substation.trim() && x.transformer.trim() ? xfmrName(x) : ''
          return (
            <div key={`x${i}`} className="dacinit-card">
              <CardHead kind="Transformer" onRemove={() => xfmrOps.remove(i)}>
                <span className="dacinit-id dacinit-id-wide">
                  <span className="dacinit-id-prefix">XFMR_</span>
                  <input value={x.substation} placeholder="Goodbee" spellCheck={false}
                    onChange={(e) => setXfmr(i, { substation: e.target.value })} />
                  <span className="dacinit-id-prefix">_</span>
                  <input className="dacinit-id-short" value={x.transformer} placeholder="T1" spellCheck={false}
                    onChange={(e) => setXfmr(i, { transformer: e.target.value })} />
                </span>
                {name && (isOnMap(name) ? <Chip tone="exists">On AreaMap</Chip> : <Chip tone="new">New</Chip>)}
              </CardHead>
              <div className="dacinit-card-row">
                <Field label="Rated" unit="MVA">
                  <input className="ui-input" value={x.ratedMva} placeholder="14"
                    onChange={(e) => setXfmr(i, { ratedMva: e.target.value })} />
                </Field>
{x.substation.trim() && (() => {
                  const found = substationClients(clients, x.substation)
                  return (
                    <Field label="DNP client">
                      <span className={`dacinit-found${found.length === 1 ? '' : ' is-unknown'}`}>
                        {found.length ? found.join(', ') : 'None found'}
                      </span>
                    </Field>
                  )
                })()}
              </div>
            </div>
          )
        })}

        {connectors.map((c, i) => {
          const name = connName(c)
          const newRemote = isNewRemote(c)
          return (
            <div key={`c${i}`} className="dacinit-card">
              <CardHead kind="Connector" onRemove={() => connOps.remove(i)}>
                <span className="dacinit-self">{name || 'R…_Connector'}</span>
                {name && (isOnMap(name) ? <Chip tone="exists">On AreaMap</Chip> : <Chip tone="new">New</Chip>)}
                {newRemote && <Chip tone="update">New manager</Chip>}
              </CardHead>
              <div className="dacinit-card-row">
                <Field label="Remote DAC">
                  <RefInput value={c.remoteDac} names={remotes} list="dacinit-remotes" placeholder={remotes[0] ?? 'Eunice'}
                    strict={false} onChange={(v) => setConn(i, { remoteDac: v })} />
                </Field>
                {wantsName && (
                  <Field label="Name">
                    <input className="ui-input" value={c.connection} placeholder="6421A_6404B"
                      onChange={(e) => setConn(i, { connection: e.target.value })} />
                  </Field>
                )}
                {newRemote && <>
                  <Field label="Port">
                    <input className="ui-input" value={c.port} placeholder="59056"
                      onChange={(e) => setConn(i, { port: e.target.value })} />
                  </Field>
                  <Field label="Remote IP" grow>
                    <input className="ui-input" value={c.remoteIp} placeholder="192.168.199.22"
                      onChange={(e) => setConn(i, { remoteIp: e.target.value })} />
                  </Field>
                </>}
              </div>
              <Flow>
                <span className="dacinit-remote">{c.remoteDac.trim() || 'Remote DAC'}</span>
                <Arrow />
                <Self name={name} />
                <Arrow />
                <RefInput value={c.feeds} names={tieNames} list="dacinit-ties" placeholder="Tie recloser"
                  onChange={(v) => setConn(i, { feeds: v })} />
              </Flow>
            </div>
          )
        })}

        <div className="dacinit-add">
          <Button onClick={() => setReclosers((rows) => [...rows, newRec()])}>+ Recloser</Button>
          <Button onClick={() => setFeedersBreakers((rows) => [...rows, newFb(defaultBreaker(family))])}>+ Feeder</Button>
          <Button onClick={() => setTransformers((rows) => [...rows, newXfmr()])}>+ Transformer</Button>
          <Button onClick={() => setConnectors((rows) => [...rows, newConn()])}>+ Connector</Button>
        </div>

        <SectionHeader title="Generate" />
        <div className="tool-row">
          <Button variant="primary" disabled={!ready} onClick={() => generate()}>
            Generate
          </Button>
          <span className="tool-stats">
            {deviceCount} device{deviceCount === 1 ? '' : 's'}
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
            <div className="dacinit-conflicts-head">Already in {result.entryName}</div>
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

        {result && <SectionHeader title="Review" />}
        {result && (
          <RunOutputs
            tool="dacinit"
            run={result.run}
            reports={result.reports}
            downloadOnly
            rowActions={() => saveButton}
          >
            <div className="dacinit-summary">
              {summaryRow('Scheme', result.family)}
              {addedSummary && summaryRow('Add', addedSummary)}
              {updatedSummary && summaryRow('Update', updatedSummary)}
              {result.unchanged.length > 0 && summaryRow('Unchanged', result.unchanged.join(', '))}
              {replacedSummary && summaryRow('Overwrite', replacedSummary)}
              {result.wired.scada.length > 0 && summaryRow('SCADA map', result.wired.scada
                .map((s) => `${s.group} from ${s.template}`).join(' · '))}
              {result.wired.areaMap.length > 0 && summaryRow('AreaMap', result.wired.areaMap
                .map((p) => `${p.name} ${p.where}`).join(' · '))}
              {result.wired.faults.length > 0 && summaryRow('Fault logic', result.wired.faults
                .map((f) => `${f.name} in ${f.program}${f.created ? ' (new)' : ''}`).join(' · '))}
              {result.wired.excluded.length > 0 && summaryRow('Excluded', result.wired.excluded.join(', '))}
              {alreadyDeclared.length > 0 && summaryRow('Declared', alreadyDeclared.join(', '))}
            </div>
            {!result.changed && (
              <div className="tool-row"><span className="tool-stats">Nothing new to save.</span></div>
            )}
            {result.changed > 0 && result.reports.length === 0 && <div className="tool-row">{saveButton}</div>}
            {saved && (
              <div className="tool-row">
                <span className="tool-stats">Saved {saved} — “{result.note}”</span>
              </div>
            )}
          </RunOutputs>
        )}
      </div>
    </>
  )
}
