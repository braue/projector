// Switch Settings — the SWSET editor without the Excel round-trip: upload a
// SEL-273x Configuration XML, edit the settings in place, generate the
// updated XML. Values shown are the old workbook's translated labels; the
// backend translates them back on write.

import { useRef, useState } from 'react'

import { generateSwsetXml, parseSwsetProjectFile, parseSwsetXml } from '../api'
import { Button, CollapsibleSection, Spinner, TabBar, TextInput } from '../components/ui'
import { errorMessage } from '../lib/errors'
import type { SwsetGenerateResult, SwsetModel, SwsetTable } from '../types'
import { ProjectFilePick } from './ProjectFilePick'
import type { ToolProps } from './registry'
import { RunOutputs } from './RunOutputs'

type TableEdits = { fields?: Record<string, string>; rows?: Record<string, string>[] }

const asText = (value: string | null | undefined) => (value == null ? '' : String(value))

function initialEdits(model: SwsetModel): Record<string, TableEdits> {
  const edits: Record<string, TableEdits> = {}
  for (const section of model.sections) {
    for (const table of section.tables) {
      if (table.kind === 'fields') {
        edits[table.id] = {
          fields: Object.fromEntries(table.fields.map((f) => [f.id, asText(table.values[f.id])])),
        }
      } else if (table.kind === 'list') {
        edits[table.id] = {
          rows: table.rows.map((row) => Object.fromEntries(
            table.columns.map((c) => [c.id, asText(c.fixed ?? row[c.id])]),
          )),
        }
      }
    }
  }
  return edits
}

export function SwsetTool({ project }: ToolProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<SwsetModel | null>(null)
  const [edits, setEdits] = useState<Record<string, TableEdits>>({})
  const [section, setSection] = useState('system')
  const [result, setResult] = useState<SwsetGenerateResult | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const load = async (request: () => Promise<SwsetModel>) => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const parsed = await request()
      setModel(parsed)
      setEdits(initialEdits(parsed))
      setSection(parsed.sections[0]?.id ?? 'system')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const parse = (file: File) => load(() => parseSwsetXml(file))

  const setField = (tableId: string, fieldId: string, value: string) => {
    setEdits((current) => ({
      ...current,
      [tableId]: { ...current[tableId], fields: { ...current[tableId]?.fields, [fieldId]: value } },
    }))
  }

  const setCell = (tableId: string, rowIndex: number, columnId: string, value: string) => {
    setEdits((current) => {
      const rows = [...(current[tableId]?.rows ?? [])]
      rows[rowIndex] = { ...rows[rowIndex], [columnId]: value }
      return { ...current, [tableId]: { ...current[tableId], rows } }
    })
  }

  const addRow = (table: SwsetTable & { kind: 'list' }) => {
    setEdits((current) => ({
      ...current,
      [table.id]: {
        ...current[table.id],
        rows: [
          ...(current[table.id]?.rows ?? []),
          Object.fromEntries(table.columns.map((c) => [c.id, c.fixed ?? ''])),
        ],
      },
    }))
  }

  const generate = async () => {
    if (!model) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await generateSwsetXml(model.run, edits))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const renderTable = (table: SwsetTable) => {
    if (table.kind === 'nameplate') {
      return (
        <CollapsibleSection key={table.id} title={table.label}>
          <div className="swset-fields">
            {table.fields.map((field) => (
              <div className="swset-field" key={field.id}>
                <span className="ui-label">{field.label}</span>
                <span className="swset-readonly mono">{asText(table.values[field.id]) || '—'}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )
    }
    if (table.kind === 'fields') {
      return (
        <CollapsibleSection key={table.id} title={table.label}>
          <div className="swset-fields">
            {table.fields.map((field) => (
              <div className="swset-field" key={field.id}>
                {field.readOnly ? (
                  <>
                    <span className="ui-label">{field.label}</span>
                    <span className="swset-readonly mono">{asText(table.values[field.id]) || '—'}</span>
                  </>
                ) : (
                  <TextInput
                    label={field.label}
                    value={edits[table.id]?.fields?.[field.id] ?? ''}
                    onChange={(e) => setField(table.id, field.id, e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )
    }
    const rows = edits[table.id]?.rows ?? []
    return (
      <CollapsibleSection key={table.id} title={table.label} count={rows.length}>
        {rows.length === 0 && !table.canAddRows && (
          <div className="tool-empty">None configured in this file.</div>
        )}
        {rows.length > 0 && (
          <div
            className="swset-grid"
            style={{ gridTemplateColumns: `repeat(${table.columns.length}, minmax(110px, 1fr))` }}
          >
            {table.columns.map((column) => (
              <span className="swset-grid-head" key={column.id}>{column.label}</span>
            ))}
            {rows.map((row, i) => table.columns.map((column) => (
              <span key={`${i}:${column.id}`}>
                {column.fixed || column.readOnly ? (
                  <span className="swset-readonly mono">{asText(column.fixed ?? row[column.id]) || '—'}</span>
                ) : (
                  <TextInput
                    value={row[column.id] ?? ''}
                    onChange={(e) => setCell(table.id, i, column.id, e.target.value)}
                  />
                )}
              </span>
            )))}
          </div>
        )}
        {table.canAddRows && (
          <div className="tool-row swset-addrow">
            <Button onClick={() => addRow(table)}>Add row</Button>
          </div>
        )}
      </CollapsibleSection>
    )
  }

  const active = model?.sections.find((s) => s.id === section)
  return (
    <>
      <div className="preview-header">
        <div className="preview-title-row">
          <h2>Switch Settings</h2>
          {busy && <Spinner />}
          {model && <span className="tool-stats">{model.deviceType} · {model.fid}</span>}
        </div>
        <div className="preview-subtitle">
          Edit an SEL-273x managed-switch configuration in place — upload the
          device XML, change what you need, generate the updated XML.
        </div>
      </div>
      <div className="tool-scroll">
        <input
          ref={input}
          type="file"
          accept=".xml"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) parse(file)
            e.target.value = ''
          }}
        />
        <button
          className="drop-zone as-button"
          onClick={() => input.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) parse(file)
          }}
        >
          <b>Drop a switch Configuration XML here</b>
          or click to browse — SEL-2730M / 2731 family
        </button>
        <ProjectFilePick
          project={project}
          extensions={['.xml']}
          onPick={(path) => load(() => parseSwsetProjectFile(project, path))}
          disabled={busy}
        />

        {error && <div className="tool-error">{error}</div>}

        {model && active && (
          <>
            <TabBar
              tabs={model.sections.map((s) => ({ key: s.id, label: s.label }))}
              activeKey={section}
              onSelect={setSection}
            />
            {active.tables.map(renderTable)}
            <div className="tool-row">
              <Button variant="primary" disabled={busy} onClick={generate}>
                Generate updated XML
              </Button>
              {result && (
                <span className="tool-stats">
                  {result.applied} settings written
                  {result.skipped.length > 0 && ` · ${result.skipped.length} skipped (not in this file)`}
                </span>
              )}
            </div>
            {result && (
              <RunOutputs tool="swset" run={result.run} reports={result.reports} />
            )}
          </>
        )}
      </div>
    </>
  )
}
