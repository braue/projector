// QuickSet Extract — dump a QuickSet database (or upload an exported-configs
// ZIP), then inventory the relay fleet and pull chosen settings across it.
// Database credentials are typed here per run and never stored.

import { useState } from 'react'

import {
  extractQuicksetSettings,
  fetchQuicksetInventory,
  importQuicksetProjectConfigs,
  startQuicksetDump,
  uploadQuicksetConfigs,
} from '../api'
import {
  Button,
  CollapsibleSection,
  DataTable,
  FileDropZone,
  SectionHeader,
  Spinner,
  TextArea,
  TextInput,
} from '../components/ui'
import { errorMessage } from '../lib/errors'
import { useToolJob } from '../lib/useToolJob'
import type { QuicksetExtract, QuicksetInventory } from '../types'
import { ProjectFilePick } from './ProjectFilePick'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

const DEFAULT_SETTINGS = [
  'OUT101', 'OUT102', 'OUT103', 'OUT104', 'OUT105', 'OUT106', 'OUT107', 'OUT108',
  'OUT201', 'OUT202', 'OUT203', 'OUT204', 'OUT205', 'OUT206', 'OUT207', 'OUT208',
  'OUT209', 'OUT210',
].join(' ')

export function QuicksetTool({ project }: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<string | null>(null)

  // Database dump form + its job.
  const [db, setDb] = useState({ host: 'localhost', port: '5432', dbname: '', user: 'postgres', password: '' })

  const [inventory, setInventory] = useState<QuicksetInventory | null>(null)
  const [busy, setBusy] = useState(false)
  const [terms, setTerms] = useState(DEFAULT_SETTINGS)
  const [extract, setExtract] = useState<QuicksetExtract | null>(null)

  const openRun = async (runId: string) => {
    setRun(runId)
    setExtract(null)
    setInventory(null)
    setBusy(true)
    try {
      setInventory(await fetchQuicksetInventory(runId))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // The dump job; its run becomes the source.
  const { job, running: dumping, start } = useToolJob(
    (result) => {
      const settled = result as { run?: string } | null
      if (settled?.run) openRun(settled.run)
    },
    setError,
  )

  const startDump = async () => {
    setError(null)
    try {
      const { job: id } = await startQuicksetDump({
        host: db.host,
        port: Number(db.port) || undefined,
        dbname: db.dbname,
        user: db.user,
        password: db.password,
      })
      start(id)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const openSource = async (request: () => Promise<{ run: string }>) => {
    setError(null)
    setBusy(true)
    try {
      const { run: runId } = await request()
      await openRun(runId)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const uploadZip = (file: File) => openSource(() => uploadQuicksetConfigs(file))

  const runExtract = async () => {
    if (!run) return
    setError(null)
    setBusy(true)
    try {
      setExtract(await extractQuicksetSettings(run, terms.split(/[\s,;]+/).filter(Boolean)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const field = (key: keyof typeof db, label: string, type = 'text') => (
    <TextInput
      label={label}
      type={type}
      value={db[key]}
      disabled={dumping}
      onChange={(e) => setDb((current) => ({ ...current, [key]: e.target.value }))}
    />
  )

  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>QuickSet Extract</h2>
          {(busy || dumping) && <Spinner />}
        </div>
      </div>
      <div className="tool-scroll">
        <SectionHeader title="Source" />
        <FileDropZone accept=".zip" onFile={uploadZip}>
          <b>Drop an exported-configs ZIP here</b>
          or click to browse — the location/device tree from a previous dump
        </FileDropZone>
        <ProjectFilePick
          project={project}
          extensions={['.zip']}
          onPick={(path, fromProject) => openSource(() => importQuicksetProjectConfigs(fromProject, path))}
          disabled={busy}
        />
        <div className="tool-col">
          {field('host', 'DB host')}
          {field('port', 'Port')}
          {field('dbname', 'Database')}
          {field('user', 'User')}
          {field('password', 'Password', 'password')}
          <div className="tool-row">
            <Button variant="primary" disabled={dumping || !db.dbname} onClick={startDump}>
              Dump database
            </Button>
          </div>
        </div>
        {job && (
          <div className="tool-joblog">
            {job.progress !== null && job.status === 'running' && (
              <div className="tool-stats">{Math.round(job.progress * 100)}%</div>
            )}
            {job.log.slice(-8).map((entry, i) => (
              <div key={i} className="tool-joblog-line">{entry}</div>
            ))}
          </div>
        )}

        {error && <div className="tool-error">{error}</div>}

        {inventory && (
          <>
            <CollapsibleSection title="Relay inventory" count={inventory.rows.length}>
              <DataTable
                maxHeight="300px"
                columns={[
                  { key: 'location', label: 'Location' },
                  { key: 'device', label: 'Device' },
                  { key: 'relayType', label: 'Relay type' },
                  { key: 'firmware', label: 'Firmware' },
                ]}
                rows={inventory.rows.map((row, i) => ({
                  id: `${row.location}/${row.device}:${i}`,
                  cells: row,
                }))}
              />
              <RunOutputs tool="quickset" run={inventory.run} reports={inventory.reports} />
            </CollapsibleSection>

            <SectionHeader title="Settings extraction" />
            <TextArea
              rows={3}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Setting names, space or comma separated — e.g. OUT101 OUT102"
            />
            <div className="tool-row">
              <Button variant="primary" disabled={busy} onClick={runExtract}>Extract</Button>
              {extract && (
                <span className="tool-stats">
                  {extract.hits} values from {extract.filesChecked} files
                </span>
              )}
            </div>
            {extract && (
              <>
                <DataTable
                  maxHeight="380px"
                  columns={extract.columns.map((c) => ({ key: c, label: c }))}
                  rows={extract.rows.map((row, i) => ({ id: String(i), cells: row }))}
                />
                <RunOutputs tool="quickset" run={extract.run} reports={extract.reports} />
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}
