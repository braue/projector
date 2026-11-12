// QuickSet Extract — read a QuickSet database backup ZIP (or a bare
// DMData.dump) without restoring it: the device tree, each device's
// connection, its newest settings, a standalone device browser, and a
// fleet-wide pull of chosen settings. The backup password is typed per run
// and never stored.

import { useState } from 'react'

import {
  extractQuicksetSettings,
  fetchQuicksetResult,
  locateQuicksetBackup,
  quicksetViewerUrl,
  sendQuicksetSlice,
  startQuicksetProjectRead,
  startQuicksetRead,
} from '../api'
import {
  Button,
  CollapsibleSection,
  DataTable,
  DropZone,
  LinkButton,
  SectionHeader,
  TextArea,
  TextInput,
} from '../components/ui'
import { errorMessage } from '../lib/errors'
import { useToolJob } from '../lib/useToolJob'
import type { QuicksetExtract, QuicksetResult } from '../types'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'
import { ToolHeader } from './ToolHeader'

const DEFAULT_SETTINGS = [
  'OUT101', 'OUT102', 'OUT103', 'OUT104', 'OUT105', 'OUT106', 'OUT107', 'OUT108',
  'OUT201', 'OUT202', 'OUT203', 'OUT204', 'OUT205', 'OUT206', 'OUT207', 'OUT208',
  'OUT209', 'OUT210',
].join(' ')

type Source =
  | { kind: 'disk'; file: File; name: string }
  | { kind: 'project'; project: string; path: string; name: string }

export function QuicksetTool(_props: ToolProps) {
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<Source | null>(null)
  const [password, setPassword] = useState('')
  const [result, setResult] = useState<QuicksetResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [terms, setTerms] = useState(DEFAULT_SETTINGS)
  const [extract, setExtract] = useState<QuicksetExtract | null>(null)

  const { job, running, start } = useToolJob(
    (settled) => {
      const run = (settled as { run?: string } | null)?.run
      if (!run) return
      fetchQuicksetResult(run).then(setResult, (err) => setError(errorMessage(err)))
    },
    setError,
  )

  const pick = (next: Source) => {
    setSource(next)
    setError(null)
  }

  const read = async () => {
    if (!source) return
    setError(null)
    setResult(null)
    setExtract(null)
    setBusy(true)
    try {
      if (source.kind === 'project') {
        const { job: id } = await startQuicksetProjectRead(source.project, source.path, password)
        start(id)
      } else {
        const located = await locateQuicksetBackup(source.file)
        const { run, job: id } = await startQuicksetRead(source.name, password, located)
        start(id)
        // The job reports its own failure; this only catches a send that
        // never reached it.
        sendQuicksetSlice(run, source.file, located).catch(() => {})
      }
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const runExtract = async () => {
    if (!result) return
    setError(null)
    setBusy(true)
    try {
      setExtract(await extractQuicksetSettings(result.run, terms.split(/[\s,;]+/).filter(Boolean)))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ToolHeader title="QuickSet Extract" busy={busy || running} />
      <div className="tool-scroll">
        <SectionHeader title="Source" />
        <DropZone
          extensions={['.zip', '.dump']}
          onFile={(file) => pick({ kind: 'disk', file, name: file.name })}
          onEntries={(project, [path]) => pick({ kind: 'project', project, path, name: path.split('/').pop() ?? path })}
          disabled={busy || running}
        >
          <b>{source ? source.name : 'Drop a QuickSet database backup here'}</b>
          {!source && 'from the tree or disk, or click to browse'}
        </DropZone>
        <div className="tool-col">
          <TextInput
            label="Backup password"
            type="password"
            value={password}
            disabled={running}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="tool-row">
            <Button variant="primary" disabled={!source || busy || running} onClick={read}>
              Read backup
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

        {result && (
          <>
            <div className="tool-row">
              <span className="tool-stats">
                {result.rows.length} devices · {result.folders} folders · {result.withSettings} with settings
              </span>
              <LinkButton href={quicksetViewerUrl(result.run)} target="_blank" rel="noreferrer">
                Open device browser
              </LinkButton>
            </div>
            <CollapsibleSection title="Devices" count={result.rows.length}>
              <DataTable
                maxHeight="360px"
                columns={[
                  { key: 'folder', label: 'Folder' },
                  { key: 'device', label: 'Device' },
                  { key: 'deviceType', label: 'Type' },
                  { key: 'firmware', label: 'Firmware' },
                  { key: 'address', label: 'IP:port' },
                  { key: 'inService', label: 'In service' },
                  { key: 'settingsDate', label: 'Settings' },
                ]}
                rows={result.rows.map((row) => ({
                  id: row.deviceId,
                  cells: {
                    ...row,
                    folder: row.viaParent ? `${row.folder} / ${row.viaParent}` : row.folder,
                    address: row.ipAddress ? (row.telnetPort ? `${row.ipAddress}:${row.telnetPort}` : row.ipAddress) : row.commType,
                    settingsDate: row.settingsDate.slice(0, 10),
                  },
                }))}
              />
            </CollapsibleSection>
            <RunOutputs tool="quickset" run={result.run} reports={result.reports} />

            <SectionHeader title="Settings extraction" />
            <TextArea
              rows={3}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="OUT101 OUT102"
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
