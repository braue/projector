import type { CompareItem, FileStatus, PointFieldDiff } from '../types'
import { lineDiff } from '../lib/lineDiff'
import { Preview } from './Preview'
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

// Generic page tables (Tag Processor and friends): every reference shows the
// WHOLE row — added/removed chips carry the full row text, and changed rows
// render the complete original and updated row side by side.
function PagesDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  // 'changed' pages carry row detail; added/removed/reordered pages read as
  // one line in Extras.
  const pages = diff.pages.filter((page) => page.status === 'changed')
  const added = pages.flatMap((page) => (page.added ?? []).map((row) => `${page.name} · ${row}`))
  const removed = pages.flatMap((page) => (page.removed ?? []).map((row) => `${page.name} · ${row}`))
  // No identity column: the whole-row text leads with the row's own cells,
  // and generic-page labels (the lead cell) are often meaningless — Tag
  // Processor rows all lead with Build = True.
  const changedRows: TableRow[] = pages.flatMap((page) =>
    (page.changed ?? []).map((row, i) => ({
      id: `${page.name}:${i}`,
      tone: 'edited' as const,
      cells: { page: page.name, original: row.original, updated: row.updated },
      titles: { original: row.original, updated: row.updated },
    })))
  if (!added.length && !removed.length && !changedRows.length) return null

  return (
    <section>
      <SectionHeader
        title="Table Changes"
        count={`+${added.length} −${removed.length} ~${changedRows.length}`}
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
            { key: 'original', label: 'Original' },
            { key: 'updated', label: 'New' },
          ]}
          rows={changedRows}
        />
      )}
    </section>
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

// One section per changed part (interface / implementation), diffed and
// numbered separately — the gutter numbers match Inspect's code view and
// search's "implementation · line N" locations.
function CodeDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  if (!diff.code) return null
  const parts = (
    [
      ['Interface', diff.code.interface],
      ['Implementation', diff.code.implementation],
    ] as const
  ).filter(([, part]) => part)
  return (
    <>
      {parts.map(([label, part]) => (
        <section key={label}>
          <SectionHeader title={`Logic Source · ${label}`} />
          <pre className="code code-diff">
            {lineDiff(part!.original ?? '', part!.updated ?? '').map((line, i) => (
              <div key={i} className={`diff-line diff-${line.kind}`}>
                <span className="diff-ln">{line.oldNo ?? ''}</span>
                <span className="diff-ln">{line.newNo ?? ''}</span>
                <span className="diff-sign">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                </span>
                {line.text}
              </div>
            ))}
          </pre>
        </section>
      ))}
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
