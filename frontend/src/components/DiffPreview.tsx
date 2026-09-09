import { useMemo, useState } from 'react'

import type { CompareItem, FileStatus, PageDiff } from '../types'
import { lineDiff, type DiffLine } from '../lib/lineDiff'
import { ST_START, tokenizeLine, type StToken } from '../lib/st'
import { Preview } from './Preview'
import { StText } from './StText'
import { Button, DataTable, SectionHeader, Tabbed, Tag, type TableRow } from './ui'

// Right pane in compare mode. An added or removed file renders its full
// preview under a status banner — the diff of everything-vs-nothing is just
// the thing itself. An edited file renders the structured diff, laid out
// exactly like Inspect's Browse pane: the narrative sections (settings rows,
// logic source, extras) scroll in the upper region, and every table that
// changed is a sheet in a tab strip below them.
//
// The tab strip is the point, not decoration. A tag list's categories —
// Binary Inputs, Analog Inputs, Binary Outputs — are what you are reading
// the diff to tell apart; stacked end to end they blur into one scroll, so
// they get the same tabs here that Inspect gives them.
//
// The tables carry no maxHeight: cells wrap whole values (a changed page row
// runs hundreds of characters), so a short inner window would show a row and
// a half at a time. The active sheet owns the lower region and scrolls it —
// sticky table headers still track it.

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

// Every changed table — a point map (a DNP shared map, an Analog Inputs page)
// and a generic page (Tag Processor and friends) alike: one REAL table per
// page, its own columns as headers, one row per added/removed row, and a
// was/now row pair per changed row. Point maps used to render as a wall of
// "+ page · tag" chips, which said a thousand points arrived and nothing
// about what they were; AcSELerator shows a shared map as a table, and so
// does this.

// A whole shared map can arrive at once, and committing thousands of rows in
// one render stalls the pane — the same cap Inspect puts on big sheets.
const DIFF_ROW_CAP = 500

function PageDiffTable({ page, label }: { page: PageDiff; label: string }) {
  // The backend's `changes` list arrives pre-merged and pre-sorted by row
  // position, with edits already split into displayed `fields` and hidden
  // noise-column edits — this component only styles it.
  //
  // Added/removed rows show their content (the content IS the edit);
  // changed pairs show the identity cells (`keyColumns` — the row's name and
  // its protocol address) and the edited cells, with hidden edits in the
  // trailing "Other edits" cell. Memoized: ancestors re-render at
  // pointer-move frequency during rail drags, and a 2000-change table must
  // not rebuild per frame.
  const [showAll, setShowAll] = useState(false)
  const { columns, rows, anyHidden, capRows } = useMemo(() => {
    const columns = page.columns ?? []
    const changes = page.changes ?? []
    const keys = new Set(page.keyColumns ?? [])
    const hidden = changes.some((entry) => entry.hidden?.length)
    const hiddenText = (entry: (typeof changes)[number]) =>
      (entry.hidden ?? [])
        .map((edit) => `${edit.column}: ${edit.original ?? '—'} → ${edit.updated ?? '—'}`)
        .join(';  ')
    const cells = (row: Record<string, string>) =>
      Object.fromEntries(columns.map((column) => [column, row[column] ?? '']))

    const built: TableRow[] = changes.flatMap((entry, i) => {
      if (entry.kind !== 'changed') {
        const added = entry.kind === 'added'
        return [{
          id: `${entry.kind}${i}`,
          tone: (added ? 'added' : 'removed') as TableRow['tone'],
          cells: { __change: `${added ? '+' : '−'} ${entry.index + 1}`, ...cells(entry.row!) },
        }]
      }
      const visible = new Set(entry.fields)
      const pick = (row: Record<string, string>) =>
        Object.fromEntries(columns.map((column) => [
          column,
          visible.has(column) || keys.has(column) ? row[column] ?? '' : '',
        ]))
      return [
        {
          id: `c${i}o`,
          tone: 'edited' as TableRow['tone'],
          cells: { __change: `~ ${entry.index + 1} was`, ...pick(entry.original!) },
        },
        {
          id: `c${i}n`,
          tone: 'edited' as TableRow['tone'],
          cells: {
            __change: `~ ${entry.index + 1} now`,
            ...pick(entry.updated!),
            ...(hidden ? { __other: hiddenText(entry) } : {}),
          },
        },
      ]
    })

    // Where the cap falls, counted in CHANGES so a was/now pair is never cut
    // in half.
    let cap = 0
    for (const entry of changes) {
      if (cap >= DIFF_ROW_CAP) break
      cap += entry.kind === 'changed' ? 2 : 1
    }
    return { columns, rows: built, anyHidden: hidden, capRows: cap }
  }, [page])

  const capped = !showAll && rows.length > capRows

  return (
    // sheet-pane: this table IS the lower region — header pinned, viewport
    // taking the rest — rather than one more block in a stack.
    <section className="sheet-pane">
      <SectionHeader
        title={`${label} · ${page.name}`}
        count={(['added', 'removed', 'changed'] as const)
          .map((kind, i) => `${'+−~'[i]}${(page.changes ?? []).filter((entry) => entry.kind === kind).length}`)
          .join(' ')}
      />
      <DataTable
        columns={[
          { key: '__change', label: 'Row' },
          ...columns.map((column) => ({ key: column, label: column })),
          ...(anyHidden ? [{ key: '__other', label: 'Other edits' }] : []),
        ]}
        rows={capped ? rows.slice(0, capRows) : rows}
      />
      {capped && (
        <Button onClick={() => setShowAll(true)}>Show all {rows.length} rows</Button>
      )}
    </section>
  )
}

// Point maps first, then the generic pages — a connection's own tables read
// before its plumbing. Every page the backend gave row detail for becomes a
// sheet, whether it was edited or arrived whole; a page with no detail (rows
// merely reordered) reads as one line in Extras instead.
function changedTables(diff: CompareItem['diff']) {
  return [
    ...diff.points.map((page) => ({ page, label: 'Points' })),
    ...diff.pages.map((page) => ({ page, label: 'Table' })),
  ]
    .filter((entry) => entry.page.changes?.length)
    .map(({ page, label }) => ({
      key: `${label}:${page.name}`,
      // The tab reads as the category (Analog Inputs); the sheet's own
      // header below it says which kind of table that is, and its +−~ split.
      label: page.name,
      count: page.changes?.length ?? 0,
      page,
      kind: label,
    }))
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
                new one. */}
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
  // Named exactly as the sheets above name them — a table the reader saw
  // called "Points · Binary Inputs" there must not be a "Point map" here.
  const coarsePages = [
    ...diff.points.map((page) => ({ page, label: 'Points' })),
    ...diff.pages.map((page) => ({ page, label: 'Table' })),
  ].filter((entry) => !entry.page.changes?.length)
  if (!coarsePages.length && !diff.otherFields.length) return null
  return (
    <section>
      <SectionHeader title="Other Changes" />
      <ul className="file-list">
        {coarsePages.map(({ page, label }) => (
          <li key={`${label}:${page.name}`}>
            {label} · <span className="mono">{page.name}</span>{' — '}
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
  // Before the early returns: the sheets decide the pane's layout, and hooks
  // cannot hide behind a branch.
  const tables = useMemo(() => changedTables(diff), [diff])

  if (!item) return null

  if (status === 'added' || status === 'removed') {
    return (
      <Preview
        item={item}
        banner={
          // Named by PATH, not by item name: in a whole-file compare the same
          // section name recurs under every profile, so "Reports" alone does
          // not say whose reports appeared.
          <div className={`diff-banner banner-${status}`}>
            {status === 'added'
              ? `Added — ${file} exists only in the new source.`
              : `Removed — ${file} exists only in the original source.`}
          </div>
        }
      />
    )
  }

  const empty =
    !diff.settings.length &&
    !diff.points.length &&
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
      {/* Same two-region layout as Browse: sections above, the tabbed sheet
          below. Without sheets the whole pane is one scroll instead. */}
      <div className={tables.length ? 'preview-scroll' : 'preview-scroll no-sheets'}>
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
              <CodeDiffSection diff={diff} />
              <GraphicalLogicSection diff={diff} />
              <ExtrasSection diff={diff} />
            </>
          )}
        </div>
        {status !== 'unchanged' && tables.length > 0 && (
          <Tabbed panes={tables}>
            {(pane) => <PageDiffTable key={pane.key} page={pane.page} label={pane.kind} />}
          </Tabbed>
        )}
      </div>
    </main>
  )
}
