import { useMemo, useState, type ReactNode } from 'react'

import type { LayoutItem, Point, ProjectItem, SettingPage } from '../types'
import {
  CollapsibleSection,
  DataTable,
  TabBar,
  Tag,
  TextInput,
  type TableRow,
} from './ui'

// Browse mode's right pane, modeled on Volture's RTAC item window: every item
// is "settings, points, and whatever pages are left", so one renderer handles
// all kinds and only the framing differs. Flattened config settings sit
// pinned at the top behind a filter; every tabular page — point maps (shared
// map included), then generic pages — is a sheet in a tab strip, rendered
// with the raw columns the export wrote, in its order. Kind-specific
// structure (ST source, EtherCAT topology, extension metadata, navigator
// layout) appears as sections above the sheets.

// The auto-generated pin list of a connection's protocol function block.
// Every connection has one and it describes the RTAC's own plumbing, not the
// project, so it is parsed but never shown.
const HIDDEN_PAGES = new Set(['POU Pin Settings'])

// --- header -----------------------------------------------------------------

function itemTag(item: ProjectItem): string | null {
  const tag =
    item.category === 'connection'
      ? item.role === 'client'
        ? 'Client'
        : item.role === 'server'
          ? 'Server'
          : item.role === 'peer'
            ? 'Peer'
            : item.kindLabel
      : item.kindLabel
  return tag === item.name ? null : tag
}

function itemSubtitle(item: ProjectItem): string | null {
  const parts =
    item.category === 'connection'
      ? [
          item.protocol,
          item.connectionType,
          item.endpoint,
          [item.manufacturer, item.model].filter(Boolean).join(' '),
        ]
      : [
          item.tagListType && `${item.tagListType} tag list`,
          item.pouKind,
          item.definitionName && `${item.definitionName} ${item.definitionVersion ?? ''}`.trim(),
          item.version,
        ]
  return parts.filter(Boolean).join(' · ') || null
}

// --- settings ----------------------------------------------------------------

// A busy connection carries 80+ settings, so the section carries its own
// filter: name or value, whichever you remember.
function SettingsSection({ settings }: { settings: Record<string, string> }) {
  const entries = useMemo(() => Object.entries(settings), [settings])
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    if (!wanted) return entries
    return entries.filter(
      ([key, value]) => key.toLowerCase().includes(wanted) || value.toLowerCase().includes(wanted),
    )
  }, [entries, query])

  if (!entries.length) return null

  return (
    <CollapsibleSection title="Settings" count={entries.length}>
      <div className="settings-toolbar">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings"
          aria-label="Search settings"
        />
      </div>
      {filtered.length === 0 ? (
        <p className="section-note">No settings match.</p>
      ) : (
        <div className="settings-grid">
          {filtered.map(([key, value]) => (
            <div key={key} className="setting-row">
              <span className="setting-key" title={key}>{key}</span>
              <span className="setting-value" title={value}>{value || '--'}</span>
            </div>
          ))}
        </div>
      )}
    </CollapsibleSection>
  )
}

// --- sheets ------------------------------------------------------------------

type Sheet = {
  key: string
  label: string
  columns: string[]
  rows: Record<string, string>[]
}

// One table, as the export wrote it: every column it carries, in its order,
// nothing renamed or folded together. A column empty on every row is the
// vendor's schema showing through, not this project — dropped unless that
// would empty the table.
function sheet(key: string, label: string, columns: string[], rows: Record<string, string>[]): Sheet {
  const populated = columns.filter((column) => rows.some((row) => (row[column] ?? '').trim()))
  return { key, label, columns: populated.length ? populated : columns, rows }
}

// The columns of a point page, recovered from the raw rows in first-seen
// order — every row of a page carries the same columns in the same order.
function rawColumns(points: Point[]): string[] {
  const columns: string[] = []
  const seen = new Set<string>()
  for (const point of points) {
    for (const column of Object.keys(point.raw)) {
      if (!seen.has(column)) {
        seen.add(column)
        columns.push(column)
      }
    }
  }
  return columns
}

// One sheet per point page, in export order — Binary Inputs, Analog Inputs,
// Binary Outputs for a DNP connection. A server's shared map lands in the
// same grouping: same page name, same table.
function pointSheets(points: Point[]): Sheet[] {
  const byPage = new Map<string, Point[]>()
  for (const point of points) {
    const group = byPage.get(point.page)
    if (group) group.push(point)
    else byPage.set(point.page, [point])
  }
  return [...byPage].map(([page, pagePoints]) =>
    sheet(`points:${page}`, page, rawColumns(pagePoints), pagePoints.map((p) => p.raw)),
  )
}

function sheetTableRows(s: Sheet): TableRow[] {
  return s.rows.map((row, i) => ({
    id: String(i),
    cells: row,
    titles: row,
  }))
}

function SheetTable({ sheet: s, maxHeight }: { sheet: Sheet; maxHeight?: string }) {
  return (
    <DataTable
      columns={s.columns.map((column) => ({ key: column, label: column }))}
      rows={sheetTableRows(s)}
      maxHeight={maxHeight}
    />
  )
}

function Sheets({ item }: { item: ProjectItem }) {
  const sheets = useMemo<Sheet[]>(() => {
    const points = [...item.points, ...(item.sharedMap?.points ?? [])]
    // Nothing makes page names unique within a module, so position is part of
    // the key — two identically named pages must both be reachable.
    const pages = item.pages
      .map((page, index) => ({ page, index }))
      .filter(({ page }: { page: SettingPage }) => !HIDDEN_PAGES.has(page.name))
    return [
      ...pointSheets(points),
      ...pages.map(({ page, index }) => sheet(`page:${index}`, page.name, page.columns, page.rows)),
    ]
  }, [item])

  const [activeKey, setActiveKey] = useState<string | null>(null)
  const active = sheets.find((s) => s.key === activeKey) ?? sheets[0] ?? null

  if (!active) return null

  return (
    <>
      {/* Only worth a strip when there is a choice to make. */}
      {sheets.length > 1 && (
        <TabBar
          tabs={sheets.map((s) => ({ key: s.key, label: s.label, count: s.rows.length }))}
          activeKey={active.key}
          onSelect={setActiveKey}
        />
      )}
      <SheetTable key={active.key} sheet={active} />
    </>
  )
}

// --- kind-specific sections ---------------------------------------------------

function LayoutTree({ items }: { items: LayoutItem[] }) {
  return (
    <ul className="layout-tree">
      {items.map((entry, i) => (
        <li key={i}>
          {entry.isFolder ? '▸ ' : ''}
          {entry.name}
          {entry.items.length > 0 && <LayoutTree items={entry.items} />}
        </li>
      ))}
    </ul>
  )
}

export function Preview({ item, banner }: { item: ProjectItem; banner?: ReactNode }) {
  const tag = itemTag(item)
  const subtitle = itemSubtitle(item)
  const hasSheets =
    item.points.length > 0 ||
    (item.sharedMap?.points.length ?? 0) > 0 ||
    item.pages.some((page) => !HIDDEN_PAGES.has(page.name))

  return (
    <main className="preview">
      {banner}
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{item.name ?? item.file.split('/').pop()?.replace(/\.xml$/i, '')}</h2>
          {tag && <Tag>{tag}</Tag>}
        </div>
        <div className="preview-subtitle">
          {subtitle && <>{subtitle} · </>}
          <span className="mono">{item.file}</span>
        </div>
      </header>

      <div className={hasSheets ? 'preview-scroll' : 'preview-scroll no-sheets'}>
        <div className="preview-sections">
          {item.description && (
            <CollapsibleSection title="Description">
              <p className="section-note">{item.description}</p>
            </CollapsibleSection>
          )}

          {item.hasArchivedContent && (
            <CollapsibleSection title="Logic Body">
              <p className="section-note">
                Graphical body (CFC/LD-style, stored as an archived blob) — no plain-text
                source to display.
              </p>
            </CollapsibleSection>
          )}
          {item.code?.interface?.trim() && (
            <CollapsibleSection title="Interface">
              <pre className="code">{item.code.interface}</pre>
            </CollapsibleSection>
          )}
          {item.code?.implementation?.trim() && (
            <CollapsibleSection title="Implementation">
              <pre className="code">{item.code.implementation}</pre>
            </CollapsibleSection>
          )}

          {item.nodes && item.nodes.length > 0 && (
            <CollapsibleSection title="EtherCAT Topology">
              {item.nodes.map((node, i) => (
                <div key={i} className="ecat-node">
                  <div className="ecat-title">
                    {node.name} — {node.slotCount} slots from {node.startingSlot}
                  </div>
                  <SheetTable
                    sheet={sheet(
                      `ecat:${i}`,
                      node.name ?? String(i),
                      ['Slot', ...Object.keys(node.slots[0] ?? {})],
                      node.slots.map((slot, j) => ({ Slot: String(j + 1), ...slot })),
                    )}
                  />
                </div>
              ))}
            </CollapsibleSection>
          )}

          {item.files && item.files.length > 0 && (
            <CollapsibleSection title="Extension Files" count={item.files.length}>
              <ul className="file-list">
                {item.files.map((file, i) => (
                  <li key={i} className="mono">
                    {file.name}
                    {file.functions.length > 0 && (
                      <span className="dim">
                        {' '}— {file.functions.map((fn) => `${fn.name} (${fn.type})`).join(', ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </CollapsibleSection>
          )}

          {item.layout && item.layout.length > 0 && (
            <CollapsibleSection title="Navigator Layout">
              <LayoutTree items={item.layout} />
            </CollapsibleSection>
          )}

          <SettingsSection settings={item.settings} />
        </div>

        {hasSheets ? (
          <Sheets item={item} />
        ) : (
          Object.keys(item.settings).length === 0 &&
          !item.code &&
          !item.hasArchivedContent &&
          !item.nodes?.length &&
          !item.layout?.length &&
          !item.files?.length && (
            <p className="sheet-empty">The export carries this module but no settings for it.</p>
          )
        )}
      </div>
    </main>
  )
}
