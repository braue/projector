import type { CompareItem, FileStatus } from '../types'
import { lineDiff } from '../lib/lineDiff'
import { Preview } from './Preview'
import { Chip, DataTable, SectionHeader, Tag, type TableRow } from './ui'

// Right pane in compare mode. An added or removed file renders its full
// preview under a status banner — the diff of everything-vs-nothing is just
// the thing itself. An edited file renders the structured diff: settings
// rows, point-level changes, page tables that moved, and a line diff of any
// logic source.

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
        maxHeight="45vh"
      />
    </section>
  )
}

function PointsDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  const { added, removed, changed } = diff.points
  if (!added.length && !removed.length && !changed.length) return null

  // One row per changed field; page/tag repeat so the table stays flat.
  const changedRows: TableRow[] = changed.flatMap((point, i) =>
    point.fields.map((field, j) => ({
      id: `${i}:${j}`,
      tone: 'edited' as const,
      cells: {
        page: point.page,
        tag: point.tag ?? '',
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
        title="Point Changes"
        count={`+${added.length} −${removed.length} ~${changed.length}`}
      />
      {(added.length > 0 || removed.length > 0) && (
        <div className="point-lists">
          {added.map((point, i) => (
            <Chip key={`a${i}`} tone="added">
              + {point.page} · {point.tag}
            </Chip>
          ))}
          {removed.map((point, i) => (
            <Chip key={`r${i}`} tone="removed">
              − {point.page} · {point.tag}
            </Chip>
          ))}
        </div>
      )}
      {changedRows.length > 0 && (
        <DataTable
          columns={[
            { key: 'page', label: 'Page' },
            { key: 'tag', label: 'Tag' },
            { key: 'column', label: 'Column' },
            { key: 'original', label: 'Original' },
            { key: 'updated', label: 'New' },
          ]}
          rows={changedRows}
          maxHeight="45vh"
        />
      )}
    </section>
  )
}

function CodeDiffSection({ diff }: { diff: CompareItem['diff'] }) {
  if (!diff.code) return null
  const lines = lineDiff(diff.code.original ?? '', diff.code.updated ?? '')
  return (
    <section>
      <SectionHeader title="Logic Source" />
      <pre className="code code-diff">
        {lines.map((line, i) => (
          <div key={i} className={`diff-line diff-${line.kind}`}>
            <span className="diff-sign">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </span>
            {line.text}
          </div>
        ))}
      </pre>
    </section>
  )
}

function ExtrasSection({ diff }: { diff: CompareItem['diff'] }) {
  if (!diff.pages.length && !diff.otherFields.length) return null
  return (
    <section>
      <SectionHeader title="Other Changes" />
      <ul className="file-list">
        {diff.pages.map((page) => (
          <li key={page.name}>
            Page <span className="mono">{page.name}</span> {page.status} ({page.rows} rows)
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
              <CodeDiffSection diff={diff} />
              <ExtrasSection diff={diff} />
            </>
          )}
        </div>
      </div>
    </main>
  )
}
