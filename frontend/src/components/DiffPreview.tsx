import { useMemo } from 'react'

import type { CompareItem, FileStatus, PointFieldDiff } from '../types'
import { lineDiff, type DiffLine } from '../lib/lineDiff'
import { ST_START, tokenizeLine, type StToken } from '../lib/st'
import { Preview } from './Preview'
import { StText } from './StText'
import { Chip, DataTable, SectionHeader, Tag, type TableRow } from './ui'

// Right pane in compare mode. An added or removed file renders its full
// preview under a status banner — the diff of everything-vs-nothing is just
// the thing itself. An edited file renders the structured diff: settings
// rows, point-level changes, page tables that moved, and a line diff of any
// logic source.
//
// The tables carry no maxHeight on purpose: cells wrap whole values (a
// changed page row runs hundreds of characters), so a short inner window
// would show a row and a half at a time. The pane scrolls as ONE region
// instead — sticky table headers still track it.

const STATUS_LABEL: Record<FileStatus, string> = {
  added: 'Added',
  removed: 'Removed',
  edited: 'Modified',
  unchanged: 'Unchanged',
}

function SettingsDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  if (!diff.settings.length) return null
  const rows: TableRow[] = diff.settings.map((row) => ({
    id: row.key,
    tone: row.status === 'changed' ? 'edited' : row.status,
    cells: { key: row.key, original: row.original ?? '—', updated: row.updated ?? '—' },
    titles: { original: row.original ?? '', updated: row.updated ?? '' },
  }))
  return (
    <section>
      <SectionHeader title="Setting Changes" count={diff.settings.length} />
      <DataTable
        columns={[
          { key: 'key', label: 'Setting' },
          { key: 'original', label: 'Original' },
          { key: 'updated', label: 'New' },
        ]}
        rows={rows}
      />
    </section>
  )
}

// Point maps: added/removed identities as chips, changed rows flattened to
// one table row per field (a point row is identified by its tag name, so the
// column-level view stays readable there).
function RowDiffSection({
  title,
  idLabel,
  added,
  removed,
  changed,
}: {
  title: string
  /** Header of the identity column: "Tag" for points. */
  idLabel: string
  added: string[]
  removed: string[]
  changed: { page: string; id: string; fields: PointFieldDiff[] }[]
}) {
  if (!added.length && !removed.length && !changed.length) return null

  const changedRows: TableRow[] = changed.flatMap((entry, i) =>
    entry.fields.map((field, j) => ({
      id: `${i}:${j}`,
      tone: 'edited' as const,
      cells: {
        page: entry.page,
        id: entry.id,
        column: field.column,
        original: field.original ?? '—',
        updated: field.updated ?? '—',
      },
      titles: { original: field.original ?? '', updated: field.updated ?? '' },
    })),
  )

  return (
    <section>
      <SectionHeader
        title={title}
        count={`+${added.length} −${removed.length} ~${changed.length}`}
      />
      {(added.length > 0 || removed.length > 0) && (
        <div className="point-lists">
          {added.map((label, i) => (
            <Chip key={`a${i}`} tone="added">+ {label}</Chip>
          ))}
          {removed.map((label, i) => (
            <Chip key={`r${i}`} tone="removed">− {label}</Chip>
          ))}
        </div>
      )}
      {changedRows.length > 0 && (
        <DataTable
          columns={[
            { key: 'page', label: 'Page' },
            { key: 'id', label: idLabel },
            { key: 'column', label: 'Column' },
            { key: 'original', label: 'Original' },
            { key: 'updated', label: 'New' },
          ]}
          rows={changedRows}
        />
      )}
    </section>
  )
}

function PointsDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  const { added, removed, changed } = diff.points
  return (
    <RowDiffSection
      title="Point Changes"
      idLabel="Tag"
      added={added.map((point) => `${point.page} · ${point.tag ?? ''}`)}
      removed={removed.map((point) => `${point.page} · ${point.tag ?? ''}`)}
      changed={changed.map((point) => ({ page: point.page, id: point.tag ?? '', fields: point.fields }))}
    />
  )
}

// Generic page tables (Tag Processor and friends): one REAL table per
// changed page — its own columns as headers, one row per added/removed row,
// and a was/now row pair per changed row. Run-on "Col = value · …" strings
// were unreadable at 15 columns.
function PageDiffTable({ page }: { page: CompareItem['diff']['pages'][number] }) {
  const columns = page.columns ?? []
  const cells = (row: Record<string, string>) =>
    Object.fromEntries(columns.map((column) => [column, row[column] ?? '']))

  // Sorted by ROW POSITION (solve order), not grouped by change kind; the
  // leading column carries the row number. Removed rows sort by where they
  // used to live and come first on ties.
  const rows: TableRow[] = [
    ...(page.added ?? []).map((entry, i) => ({
      index: entry.index,
      rank: 2,
      rows: [{
        id: `a${i}`,
        tone: 'added' as const,
        cells: { __change: `+ ${entry.index + 1}`, ...cells(entry.row) },
      }],
    })),
    ...(page.removed ?? []).map((entry, i) => ({
      index: entry.index,
      rank: 0,
      rows: [{
        id: `r${i}`,
        tone: 'removed' as const,
        cells: { __change: `− ${entry.index + 1}`, ...cells(entry.row) },
      }],
    })),
    ...(page.changed ?? []).map((entry, i) => ({
      index: entry.index,
      rank: 1,
      rows: [
        {
          id: `c${i}o`,
          tone: 'edited' as const,
          cells: { __change: `~ ${entry.index + 1} was`, ...cells(entry.original) },
        },
        {
          id: `c${i}n`,
          tone: 'edited' as const,
          cells: { __change: `~ ${entry.index + 1} now`, ...cells(entry.updated) },
        },
      ],
    })),
  ]
    .sort((a, b) => a.index - b.index || a.rank - b.rank)
    .flatMap((entry) => entry.rows)

  return (
    <section>
      <SectionHeader
        title={`Table · ${page.name}`}
        count={`+${page.added?.length ?? 0} −${page.removed?.length ?? 0} ~${page.changed?.length ?? 0}`}
      />
      <DataTable
        columns={[
          { key: '__change', label: 'Row' },
          ...columns.map((column) => ({ key: column, label: column })),
        ]}
        rows={rows}
      />
    </section>
  )
}

function PagesDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  // 'changed' pages carry row detail; added/removed/reordered pages read as
  // one line in Extras.
  const pages = diff.pages.filter((page) => page.status === 'changed')
  if (!pages.length) return null
  return (
    <>
      {pages.map((page) => (
        <PageDiffTable key={page.name} page={page} />
      ))}
    </>
  )
}

const GRAPHICAL_LOGIC_COPY: Record<string, string> = {
  added: 'A graphical logic body (CFC/LD) was added.',
  removed: 'The graphical logic body (CFC/LD) was removed.',
  changed: 'The graphical logic body (CFC/LD) changed.',
}

function GraphicalLogicSection({ diff }: { diff: CompareItem['diff'] }) {
  if (!diff.graphicalLogic) return null
  return (
    <section>
      <SectionHeader title="Graphical Logic" />
      <p className="section-note">
        {GRAPHICAL_LOGIC_COPY[diff.graphicalLogic]} The body is an archived blob this tool
        cannot decode — open the project in AcSELerator RTAC to see what changed.
      </p>
    </section>
  )
}

// Highlight diff lines, folding block-comment state along each SIDE of the
// diff separately — a (* comment *) opened in the original must not bleed
// into added lines, which belong to the new source's state.
function highlightDiff(lines: DiffLine[]): (DiffLine & { tokens: StToken[] })[] {
  let oldState = ST_START
  let newState = ST_START
  return lines.map((line) => {
    if (line.kind === 'del') {
      const result = tokenizeLine(line.text, oldState)
      oldState = result.state
      return { ...line, tokens: result.tokens }
    }
    if (line.kind === 'add') {
      const result = tokenizeLine(line.text, newState)
      newState = result.state
      return { ...line, tokens: result.tokens }
    }
    oldState = tokenizeLine(line.text, oldState).state
    const result = tokenizeLine(line.text, newState)
    newState = result.state
    return { ...line, tokens: result.tokens }
  })
}

// One changed part (interface / implementation), diffed and numbered
// separately — the gutter numbers match Inspect's code view and search's
// "implementation · line N" locations. The LCS + tokenization is memoized:
// ancestors re-render at pointer-move frequency during rail drags, and
// redoing this work per frame stutters.
function CodePartDiff({
  label,
  part,
}: {
  label: string
  part: { original: string | null; updated: string | null }
}) {
  const lines = useMemo(
    () => highlightDiff(lineDiff(part.original ?? '', part.updated ?? '')),
    [part.original, part.updated],
  )
  return (
    <section>
      <SectionHeader title={`Logic Source · ${label}`} />
      <pre className="code code-diff">
        {lines.map((line, i) => (
          <div key={i} className={`diff-line diff-${line.kind}`}>
            {/* ONE gutter: each line numbered in the side it lives in —
                deleted lines by the original file, everything else by the
                new one. Matches the PDF report's numbering. */}
            <span className="diff-ln">{line.kind === 'del' ? line.oldNo : line.newNo}</span>
            <span className="diff-sign">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </span>
            <StText tokens={line.tokens} />
          </div>
        ))}
      </pre>
    </section>
  )
}

function CodeDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  if (!diff.code) return null
  return (
    <>
      {diff.code.interface && <CodePartDiff label="Interface" part={diff.code.interface} />}
      {diff.code.implementation && (
        <CodePartDiff label="Implementation" part={diff.code.implementation} />
      )}
    </>
  )
}

function ExtrasSection({ diff }: { diff: CompareItem['diff'] }) {
  const coarsePages = diff.pages.filter((page) => page.status !== 'changed')
  if (!coarsePages.length && !diff.otherFields.length) return null
  return (
    <section>
      <SectionHeader title="Other Changes" />
      <ul className="file-list">
        {coarsePages.map((page) => (
          <li key={page.name}>
            Page <span className="mono">{page.name}</span>{' '}
            {page.status === 'reordered' ? 'rows reordered' : page.status} ({page.rows} rows)
          </li>
        ))}
        {diff.otherFields.map((field) => (
          <li key={field}>
            Field <span className="mono">{field}</span> changed
          </li>
        ))}
      </ul>
    </section>
  )
}

export function DiffPreview({ compare }: { compare: CompareItem }) {
  const { status, original, updated, diff, file } = compare
  const item = updated ?? original

  if (!item) return null

  if (status === 'added' || status === 'removed') {
    return (
      <Preview
        item={item}
        banner={
          <div className={`diff-banner banner-${status}`}>
            {status === 'added'
              ? 'Added — this object exists only in the new project.'
              : 'Removed — this object exists only in the original project.'}
          </div>
        }
      />
    )
  }

  const empty =
    !diff.settings.length &&
    !diff.points.added.length &&
    !diff.points.removed.length &&
    !diff.points.changed.length &&
    !diff.pages.length &&
    !diff.code &&
    !diff.graphicalLogic &&
    !diff.otherFields.length

  return (
    <main className="preview">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{item.name ?? file}</h2>
          <Tag tone={status === 'unchanged' ? 'default' : status}>{STATUS_LABEL[status]}</Tag>
        </div>
        <div className="preview-subtitle">
          <span className="mono">{file}</span>
        </div>
      </header>
      <div className="preview-scroll no-sheets">
        <div className="preview-sections">
          {status === 'unchanged' ? (
            <p className="section-note">Identical in both projects.</p>
          ) : empty ? (
            <p className="section-note">
              The raw XML differs, but nothing the parser models changed — likely an
              archived logic blob or formatting.
            </p>
          ) : (
            <>
              <SettingsDiffSection diff={diff} />
              <PointsDiffSection diff={diff} />
              <PagesDiffSection diff={diff} />
              <CodeDiffSection diff={diff} />
              <GraphicalLogicSection diff={diff} />
              <ExtrasSection diff={diff} />
            </>
          )}
        </div>
      </div>
    </main>
  )
}
