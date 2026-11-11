import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchFileParts,
  fetchFileView,
  fileBytesUrl,
  openFileEntry,
  openInnerFile,
  searchPdfFile,
} from '../api'
import { errorMessage } from '../lib/errors'
import { formatOf, type FileFormat } from '../lib/fileNodes'
import { formatSize } from '../lib/format'
import { useDebounced } from '../lib/useDebounced'
import { useFetch } from '../lib/useFetch'
import type { FileParts, FileViewModel, InnerChain, PdfMatch, SheetModel } from '../types'
import { FindBar, useFindInPage } from './FindBar'
import { Button } from './ui'

// The in-app viewers for plain files: images (with the text OCR read off
// them), workbooks and CSV as a grid, Word documents as HTML, decks as their
// slides, email with its attachments, zip archives as a browsable listing,
// and JSON/XML as text. The backend does the reading (GET /files/view); this
// is only drawing.
//
// A file INSIDE a container — a zip entry, an email attachment — is the same
// view one level down, addressed by its `inner` chain from the tree entry.
// Nested views render inside the parent's find root, so one Ctrl+F covers
// everything on screen.
//
// `seed` (a content hit clicked in the tree) opens find on its term, and its
// `where` ("Sheet2 · row 40", "drawings.zip › one-line.pdf · p. 2") picks the
// sheet, entry or attachment the hit is in.

/** The formats this pane draws (txt/md have the editor, PDF its own viewer). */
export function hasFileView(name: string): boolean {
  const format = formatOf(name)
  return format !== null && format !== 'text' && format !== 'pdf'
}

/** The find bar's live term, for bodies whose text is not in the DOM (a
 *  PDF inside a zip or an email renders in Chromium's viewer). */
const FindTerm = createContext('')

export interface FindSeed {
  term: string
  where: string
}

/** The part of a hit's `where` inside the step named `label`, or null. */
function within(where: string, label: string): string | null {
  if (where === label) return ''
  if (where.startsWith(`${label} › `)) return where.slice(label.length + 3)
  if (where.startsWith(`${label} · `)) return where.slice(label.length + 3)
  return null
}

export function FileView({
  project,
  path,
  name,
  seed = null,
}: {
  project: string
  path: string
  name: string
  seed?: FindSeed | null
}) {
  // The find root is whatever the body says it is: a div for most views, the
  // message frame's document for an HTML email.
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const getRoot = useCallback(() => root, [root])
  const find = useFindInPage({ getRoot, epoch: root ? 1 : 0, seed: seed?.term ?? '' })
  const [error, setError] = useState<string | null>(null)

  return (
    <main className="preview file-view">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{name}</h2>
          <Button
            className="file-view-open"
            onClick={() => openFileEntry(project, path).catch((err) => setError(errorMessage(err)))}
          >
            Open
          </Button>
        </div>
        <div className="preview-subtitle">
          <span className="mono">{path}</span>
          {error && <span className="list-error-text"> {error}</span>}
        </div>
      </header>
      {find.open && (
        <FindBar
          inputRef={find.inputRef}
          term={find.term}
          onTerm={find.setTerm}
          count={find.count}
          onStep={find.step}
          onClose={find.closeFind}
          placeholder="Find…"
        />
      )}
      <FindTerm.Provider value={find.open ? find.term.trim() : ''}>
        <FileBody
          project={project}
          path={path}
          inner={[]}
          name={name}
          where={seed?.where ?? ''}
          setRoot={setRoot}
        />
      </FindTerm.Provider>
    </main>
  )
}

/** One file's body, at any depth. */
function FileBody({
  project,
  path,
  inner,
  name,
  where,
  setRoot,
}: {
  project: string
  path: string
  inner: InnerChain
  name: string
  where: string
  /** Set by the outermost body only; nested bodies sit inside its root. */
  setRoot?: (el: HTMLElement | null) => void
}) {
  const format = formatOf(name)
  const innerKey = JSON.stringify(inner)
  const needsModel = format !== null && format !== 'image' && format !== 'pdf' && format !== 'text'
  const { data: model, error } = useFetch(
    needsModel ? () => fetchFileView(project, path, inner) : null,
    [project, path, innerKey, needsModel],
  )
  const ref = useCallback((el: HTMLDivElement | null) => setRoot?.(el), [setRoot])

  if (format === 'pdf') {
    return inner.length ? <InnerPdf project={project} path={path} inner={inner} name={name} /> : null
  }
  if (format === 'image') {
    return (
      <div className="file-body" ref={ref}>
        <ImageBody project={project} path={path} inner={inner} name={name} />
      </div>
    )
  }
  if (format === 'text') {
    return (
      <div className="file-body" ref={ref}>
        <TextBody project={project} path={path} inner={inner} />
      </div>
    )
  }
  if (model?.format === 'mail') {
    return <MailBody project={project} path={path} inner={inner} model={model} where={where} setRoot={setRoot} />
  }
  return (
    <div className="file-body" ref={ref}>
      {error ? (
        <div className="pane-message">{error}</div>
      ) : !model ? (
        <div className="pane-message">Reading…</div>
      ) : (
        <ModelBody project={project} path={path} inner={inner} model={model} where={where} format={format} />
      )}
    </div>
  )
}

function ModelBody({
  project,
  path,
  inner,
  model,
  where,
  format,
}: {
  project: string
  path: string
  inner: InnerChain
  model: FileViewModel
  where: string
  format: FileFormat | null
}) {
  switch (model.format) {
    case 'sheet':
      return <SheetBody sheets={model.sheets} where={where} csv={format === 'csv'} />
    case 'doc':
      return <DocBody html={model.html} />
    case 'slides':
      return (
        <div className="slides">
          {model.slides.map((slide) => (
            <section key={slide.number} className="slide">
              <div className="slide-number">{slide.number}</div>
              <div className="slide-body">
                {slide.title && <h3>{slide.title}</h3>}
                {slide.paragraphs.map((p, i) => (
                  <p key={i} className="slide-line" style={{ marginLeft: `${p.level * 18}px` }}>{p.text}</p>
                ))}
                {slide.images.length > 0 && (
                  <div className="slide-images">
                    {slide.images.map((src, i) => <img key={i} src={src} alt="" />)}
                  </div>
                )}
                {slide.notes && <div className="slide-notes">{slide.notes}</div>}
              </div>
            </section>
          ))}
          {!model.slides.length && <div className="pane-message">No slides.</div>}
        </div>
      )
    case 'zip':
      return <ZipBody project={project} path={path} inner={inner} entries={model.entries} where={where} />
    case 'code':
      return <pre className="code-body">{model.text}</pre>
    default:
      return <div className="pane-message">Nothing to show.</div>
  }
}

// --- images -----------------------------------------------------------------------

function useParts(project: string, path: string, inner: InnerChain) {
  const innerKey = JSON.stringify(inner)
  const [parts, setParts] = useState<FileParts | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let timer = 0
    const load = () => {
      fetchFileParts(project, path, inner)
        .then((read) => {
          if (!live) return
          setParts(read)
          // OCR runs in the background; look again until it has.
          if (read.ocr === 'pending') timer = window.setTimeout(load, 2000)
        })
        .catch((err) => live && setError(errorMessage(err)))
    }
    load()
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [project, path, innerKey])
  return { parts, error }
}

function ImageBody({ project, path, inner, name }: { project: string; path: string; inner: InnerChain; name: string }) {
  const [fit, setFit] = useState(true)
  const { parts, error } = useParts(project, path, inner)
  const text = parts?.parts.map((p) => p.text).join('\n') ?? ''
  return (
    <div className="image-body">
      <div className={fit ? 'image-stage fit' : 'image-stage'}>
        <img
          src={fileBytesUrl(project, path, inner)}
          alt={name}
          onClick={() => setFit((f) => !f)}
          title={fit ? 'Actual size' : 'Fit'}
        />
      </div>
      <div className="image-text">
        <div className="image-text-head">Text</div>
        {error ? (
          <div className="pane-message">{error}</div>
        ) : !parts || parts.ocr === 'pending' ? (
          <div className="pane-message">Reading…</div>
        ) : text ? (
          <pre className="code-body plain">{text}</pre>
        ) : (
          <div className="pane-message">None.</div>
        )}
      </div>
    </div>
  )
}

function TextBody({ project, path, inner }: { project: string; path: string; inner: InnerChain }) {
  const { parts, error } = useParts(project, path, inner)
  if (error) return <div className="pane-message">{error}</div>
  if (!parts) return <div className="pane-message">Reading…</div>
  return <pre className="code-body">{parts.parts.map((p) => p.text).join('\n')}</pre>
}

/** A PDF inside a container: Chromium's viewer, with the find bar's term
 *  answered as page hits (the same way PdfView does it for tree entries). */
function InnerPdf({ project, path, inner, name }: { project: string; path: string; inner: InnerChain; name: string }) {
  const term = useDebounced(useContext(FindTerm), 220)
  const [matches, setMatches] = useState<PdfMatch[]>([])
  const [page, setPage] = useState<number | null>(null)
  const innerKey = JSON.stringify(inner)
  useEffect(() => {
    if (!term) {
      setMatches([])
      return
    }
    let live = true
    searchPdfFile(project, path, term, inner)
      .then((result) => {
        if (!live) return
        setMatches(result.matches)
        if (result.matches.length) setPage(result.matches[0].page)
      })
      .catch(() => live && setMatches([]))
    return () => {
      live = false
    }
  }, [project, path, innerKey, term])
  const src = `${fileBytesUrl(project, path, inner)}${page ? `#page=${page}` : ''}`
  return (
    <div className="file-body inner-pdf">
      {matches.length > 0 && (
        <div className="inner-pdf-hits find-hits">
          {matches.map((hit, index) => (
            <button
              key={`${hit.page}:${index}`}
              className={hit.page === page ? 'find-hit-row on' : 'find-hit-row'}
              onClick={() => setPage(hit.page)}
            >
              <span className="find-hit-page">p. {hit.page}</span>
              <span className="find-hit-text">{hit.before}<mark>{hit.match}</mark>{hit.after}</span>
            </button>
          ))}
        </div>
      )}
      <iframe key={src} className="pdf-frame" title={name} src={src} />
    </div>
  )
}

// --- workbooks and CSV ----------------------------------------------------------

function colLetters(index: number): string {
  let s = ''
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

function SheetBody({ sheets, where, csv }: { sheets: SheetModel[]; where: string; csv: boolean }) {
  const initial = Math.max(0, sheets.findIndex((s) => where.startsWith(`${s.name} · `)))
  const [at, setAt] = useState(initial)
  const sheet = sheets[Math.min(at, sheets.length - 1)]
  if (!sheet) return <div className="pane-message">Empty.</div>
  return (
    <div className="sheet-view">
      <SheetGrid key={sheet.name} sheet={sheet} csv={csv} />
      {sheets.length > 1 && (
        <div className="sheet-tabs">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              className={[i === at ? 'sheet-tab on' : 'sheet-tab', s.hidden ? 'hidden-sheet' : ''].join(' ')}
              onClick={() => setAt(i)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// A cell range as the user drew it: anchor (r1, c1) where the drag or click
// began, focus (r2, c2) where it is now. Either corner may be the larger.
interface CellRange { r1: number; c1: number; r2: number; c2: number }

function bounds(sel: CellRange) {
  return {
    top: Math.min(sel.r1, sel.r2),
    bottom: Math.max(sel.r1, sel.r2),
    left: Math.min(sel.c1, sel.c2),
    right: Math.max(sel.c1, sel.c2),
  }
}

// Excel's own clipboard text: tab between cells, newline between rows, and a
// value holding either one quoted so it pastes back as one cell.
function tsvCell(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function htmlCell(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

type SheetGridMap = Map<number, Map<number, SheetModel['rows'][number]['cells'][number]>>

function rangeClipboard(grid: SheetGridMap, sel: CellRange) {
  const { top, bottom, left, right } = bounds(sel)
  const lines: string[] = []
  const rows: string[] = []
  for (let r = top; r <= bottom; r += 1) {
    const values: string[] = []
    for (let c = left; c <= right; c += 1) values.push(grid.get(r)?.get(c)?.v ?? '')
    lines.push(values.map(tsvCell).join('\t'))
    rows.push(`<tr>${values.map((v) => `<td>${htmlCell(v)}</td>`).join('')}</tr>`)
  }
  return { text: lines.join('\r\n'), html: `<table>${rows.join('')}</table>` }
}

// One body row. Memoized on the selection's columns within THIS row, so a
// drag repaints only the rows whose highlight changed, not all 5,000.
const SheetRow = memo(function SheetRow({
  r, cols, cells, covered, spans, selLeft, selRight, cursorCol,
}: {
  r: number
  cols: number[]
  cells: Map<number, SheetModel['rows'][number]['cells'][number]> | undefined
  covered: Set<string>
  spans: Map<string, { rowSpan: number; colSpan: number }>
  selLeft: number
  selRight: number
  cursorCol: number
}) {
  return (
    <tr>
      <th data-r={r} className={selLeft <= selRight ? 'in-sel' : undefined}>{r}</th>
      {cols.map((c) => {
        const key = `${r}:${c}`
        if (covered.has(key)) return null
        const cell = cells?.get(c)
        const span = spans.get(key)
        const numeric = cell && /^-?[\d,.]+%?$/.test(cell.v)
        // A merged cell lights up when the cursor or range lands anywhere
        // across its columns, not only on its top-left corner.
        const right = c + (span?.colSpan ?? 1) - 1
        const classes = [
          numeric ? 'num' : '',
          c <= selRight && right >= selLeft ? 'sel' : '',
          cursorCol >= c && cursorCol <= right ? 'cursor' : '',
        ].filter(Boolean).join(' ')
        return (
          <td
            key={c}
            data-r={r}
            data-c={c}
            rowSpan={span?.rowSpan}
            colSpan={span?.colSpan}
            className={classes || undefined}
            title={cell?.f ? `=${cell.f}` : undefined}
          >
            {cell?.v}
          </td>
        )
      })}
    </tr>
  )
})

function SheetGrid({ sheet, csv }: { sheet: SheetModel; csv: boolean }) {
  const { grid, lastRow, covered, spans } = useMemo(() => {
    const byRow = new Map(sheet.rows.map((row) => [row.r, new Map(row.cells.map((c) => [c.c, c]))]))
    const lastRow = sheet.rows.length ? sheet.rows[sheet.rows.length - 1].r : 0
    const covered = new Set<string>()
    const spans = new Map<string, { rowSpan: number; colSpan: number }>()
    for (const m of sheet.merges) {
      if (m.c1 > sheet.cols) continue
      spans.set(`${m.r1}:${m.c1}`, { rowSpan: Math.min(m.r2, lastRow) - m.r1 + 1, colSpan: Math.min(m.c2, sheet.cols) - m.c1 + 1 })
      for (let r = m.r1; r <= Math.min(m.r2, lastRow); r += 1) {
        for (let c = m.c1; c <= Math.min(m.c2, sheet.cols); c += 1) if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`)
      }
    }
    return { grid: byRow, lastRow, covered, spans }
  }, [sheet])

  const rows = useMemo(() => Array.from({ length: lastRow }, (_, i) => i + 1), [lastRow])
  const cols = useMemo(() => Array.from({ length: sheet.cols }, (_, i) => i + 1), [sheet.cols])
  const width = (c: number) => {
    const w = sheet.widths[c]
    if (w === 0) return 0
    return Math.min(420, Math.max(36, Math.round((w ?? (csv ? 14 : 9)) * 7 + 5)))
  }

  // Excel-style cell selection: click, drag, shift-click, or a row/column
  // header; arrows move, shift+arrows extend, Ctrl+A takes the sheet, and
  // Ctrl+C puts the range on the clipboard as cells (TSV + an HTML table),
  // so it pastes into Excel or a FAT sheet as a block, not one line of text.
  const [sel, setSel] = useState<CellRange | null>(null)
  const dragging = useRef<'cell' | 'row' | 'col' | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastCol = sheet.cols
  const maxRow = Math.max(1, lastRow)

  useEffect(() => {
    const stop = () => { dragging.current = null }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  const target = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('td, th') as HTMLElement | null
    if (!el) return null
    const r = el.dataset.r ? Number(el.dataset.r) : null
    const c = el.dataset.c ? Number(el.dataset.c) : null
    return { r, c, corner: el.classList.contains('sheet-corner') }
  }

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const hit = target(e)
    if (!hit) return
    e.preventDefault()
    scrollRef.current?.focus({ preventScroll: true })
    if (hit.corner) {
      setSel({ r1: 1, c1: 1, r2: maxRow, c2: lastCol })
      return
    }
    const kind = hit.r != null && hit.c != null ? 'cell' : hit.r != null ? 'row' : 'col'
    dragging.current = kind
    setSel((prev) => {
      if (kind === 'row') {
        const r = hit.r!
        return e.shiftKey && prev ? { r1: prev.r1, c1: 1, r2: r, c2: lastCol } : { r1: r, c1: 1, r2: r, c2: lastCol }
      }
      if (kind === 'col') {
        const c = hit.c!
        return e.shiftKey && prev ? { r1: 1, c1: prev.c1, r2: maxRow, c2: c } : { r1: 1, c1: c, r2: maxRow, c2: c }
      }
      return e.shiftKey && prev ? { ...prev, r2: hit.r!, c2: hit.c! } : { r1: hit.r!, c1: hit.c!, r2: hit.r!, c2: hit.c! }
    })
  }

  const onMouseOver = (e: React.MouseEvent) => {
    const kind = dragging.current
    if (!kind) return
    const hit = target(e)
    if (!hit) return
    setSel((prev) => {
      if (!prev) return prev
      if (kind === 'row' && hit.r != null) return { ...prev, r2: hit.r }
      if (kind === 'col' && hit.c != null) return { ...prev, c2: hit.c }
      if (kind === 'cell' && hit.r != null && hit.c != null) return { ...prev, r2: hit.r, c2: hit.c }
      return prev
    })
  }

  const copy = useCallback(() => {
    if (!sel) return
    const { text, html } = rangeClipboard(grid, sel)
    const fallback = () => navigator.clipboard?.writeText(text).catch(() => {})
    try {
      navigator.clipboard
        .write([new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        })])
        .catch(fallback)
    } catch {
      fallback()
    }
  }, [grid, sel])

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'c' || e.key === 'C') && !e.shiftKey) {
      if (!sel) return
      e.preventDefault()
      copy()
      return
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      setSel({ r1: 1, c1: 1, r2: maxRow, c2: lastCol })
      return
    }
    if (e.key === 'Escape' && sel) {
      setSel(null)
      return
    }
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
      Tab: [0, e.shiftKey ? -1 : 1], Enter: [e.shiftKey ? -1 : 1, 0],
    }
    const move = step[e.key]
    if (!move || !sel) return
    e.preventDefault()
    const extend = e.shiftKey && e.key.startsWith('Arrow')
    const from = extend ? { r: sel.r2, c: sel.c2 } : { r: sel.r1, c: sel.c1 }
    const r = Math.min(maxRow, Math.max(1, from.r + move[0]))
    const c = Math.min(lastCol, Math.max(1, from.c + move[1]))
    setSel(extend ? { ...sel, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c })
    scrollRef.current
      ?.querySelector(`td[data-r="${r}"][data-c="${c}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const box = sel ? bounds(sel) : null
  const colSelected = (c: number) => box != null && box.top === 1 && box.bottom === maxRow && c >= box.left && c <= box.right

  return (
    <div
      ref={scrollRef}
      className="sheet-scroll"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onCopy={(e) => {
        if (!sel) return
        const { text, html } = rangeClipboard(grid, sel)
        e.preventDefault()
        e.clipboardData.setData('text/plain', text)
        e.clipboardData.setData('text/html', html)
      }}
    >
      <table className="sheet-grid" onMouseDown={onMouseDown} onMouseOver={onMouseOver}>
        <colgroup>
          <col style={{ width: 44 }} />
          {cols.map((c) => <col key={c} style={{ width: width(c) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="sheet-corner" />
            {cols.map((c) => (
              <th
                key={c}
                data-c={c}
                className={box && c >= box.left && c <= box.right ? (colSelected(c) ? 'in-sel full' : 'in-sel') : undefined}
              >
                {csv ? c : colLetters(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const inRow = box != null && r >= box.top && r <= box.bottom
            return (
              <SheetRow
                key={r}
                r={r}
                cols={cols}
                cells={grid.get(r)}
                covered={covered}
                spans={spans}
                selLeft={inRow ? box.left : 0}
                selRight={inRow ? box.right : -1}
                cursorCol={sel && sel.r1 === r ? sel.c1 : 0}
              />
            )
          })}
        </tbody>
      </table>
      {sheet.totalRows > sheet.rows.length && (
        <div className="sheet-more">{sheet.rows.length.toLocaleString()} of {sheet.totalRows.toLocaleString()} rows</div>
      )}
    </div>
  )
}

// --- Word ---------------------------------------------------------------------------

function DocBody({ html }: { html: string }) {
  // Semantic HTML the backend built from the document's own text (every
  // value escaped), links already defused into data attributes.
  return <article className="doc-body" dangerouslySetInnerHTML={{ __html: html }} />
}

// --- email ------------------------------------------------------------------------

/** No scripts, nothing remote: the message can show its own inline images
 *  and styles and nothing else. */
const MAIL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"

/** Mail is written for white paper, so it stays on white in dark mode too.
 *  Find paints with CSS highlights, whose colours must live in the frame. */
function mailDocument(html: string): string {
  const base = `<meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><base target="_blank">`
  const style = '<style>html{color-scheme:light}body{margin:16px 20px;font:14px/1.5 system-ui,sans-serif;background:#fff;color:#111}img{max-width:100%;height:auto}::highlight(pj-find){background:#fff3dc}::highlight(pj-find-on){background:#e09000}</style>'
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (head) => `${head}${base}${style}`)
    : `<!doctype html><html><head>${base}${style}</head><body>${html}</body></html>`
}

function MailBody({
  project,
  path,
  inner,
  model,
  where,
  setRoot,
}: {
  project: string
  path: string
  inner: InnerChain
  model: Extract<FileViewModel, { format: 'mail' }>
  where: string
  setRoot?: (el: HTMLElement | null) => void
}) {
  // A hit inside an attachment opens that attachment.
  const seeded = model.attachments.find((a) => within(where, a.label) !== null) ?? null
  const [open, setOpen] = useState<number | null>(seeded?.index ?? null)
  const [error, setError] = useState<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const divRef = useCallback((el: HTMLDivElement | null) => {
    if (open !== null || !model.html) setRoot?.(el)
  }, [open, model.html, setRoot])
  const attachment = open === null ? null : model.attachments.find((a) => a.index === open) ?? null
  const shown = model.attachments.filter((a) => !a.inline || !model.html)

  const frameLoaded = () => {
    const body = frame.current?.contentDocument?.body ?? null
    if (open === null) setRoot?.(body)
  }

  return (
    <div className="file-body mail-body" ref={divRef}>
      <div className="mail-head">
        <div className="mail-subject">{model.subject || '(no subject)'}</div>
        <dl className="mail-fields">
          {model.from && <><dt>From</dt><dd>{model.from}</dd></>}
          {model.to && <><dt>To</dt><dd>{model.to}</dd></>}
          {model.cc && <><dt>Cc</dt><dd>{model.cc}</dd></>}
          {model.date && <><dt>Date</dt><dd>{new Date(model.date).toLocaleString()}</dd></>}
        </dl>
        {shown.length > 0 && (
          <div className="mail-attachments">
            {open !== null && (
              <button className="mail-attachment back" onClick={() => setOpen(null)}>‹ Message</button>
            )}
            {shown.map((a) => (
              <button
                key={a.index}
                className={a.index === open ? 'mail-attachment on' : 'mail-attachment'}
                onClick={() => setOpen(a.index)}
                onDoubleClick={() => openInnerFile(project, path, [...inner, a.index]).catch((err) => setError(errorMessage(err)))}
                title={`${a.name} · ${formatSize(a.size)}`}
              >
                <span className="mail-attachment-name">{a.name}</span>
                <span className="mail-attachment-size">{formatSize(a.size)}</span>
              </button>
            ))}
          </div>
        )}
        {error && <div className="list-error-text">{error}</div>}
      </div>
      {attachment ? (
        <InnerFile
          project={project}
          path={path}
          inner={[...inner, attachment.index]}
          name={attachment.name}
          where={within(where, attachment.label) ?? ''}
        />
      ) : model.html ? (
        <iframe
          ref={frame}
          className="mail-frame"
          title={model.subject}
          sandbox="allow-same-origin allow-popups"
          srcDoc={mailDocument(model.html)}
          onLoad={frameLoaded}
        />
      ) : (
        <pre className="code-body plain mail-text">{model.text}</pre>
      )}
    </div>
  )
}

/** A file inside a container: its own body, plus an Open for the OS app. */
function InnerFile({
  project,
  path,
  inner,
  name,
  where,
}: {
  project: string
  path: string
  inner: InnerChain
  name: string
  where: string
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="inner-file">
      <div className="inner-file-bar">
        <span className="inner-file-name">{name}</span>
        <Button onClick={() => openInnerFile(project, path, inner).catch((err) => setError(errorMessage(err)))}>
          Open
        </Button>
        {error && <span className="list-error-text">{error}</span>}
      </div>
      {formatOf(name) ? (
        <FileBody project={project} path={path} inner={inner} name={name} where={where} />
      ) : (
        <div className="pane-message">No preview.</div>
      )}
    </div>
  )
}

// --- archives -----------------------------------------------------------------------

function ZipBody({
  project,
  path,
  inner,
  entries,
  where,
}: {
  project: string
  path: string
  inner: InnerChain
  entries: { name: string; size: number }[]
  where: string
}) {
  const seeded = entries
    .filter((e) => within(where, e.name) !== null)
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  const [selected, setSelected] = useState<string | null>(seeded?.name ?? null)
  const entry = entries.find((e) => e.name === selected) ?? null
  return (
    <div className="zip-body">
      <div className="zip-list">
        {entries.map((e) => (
          <button
            key={e.name}
            className={e.name === selected ? 'zip-entry on' : 'zip-entry'}
            onClick={() => setSelected(e.name)}
            onDoubleClick={() => openInnerFile(project, path, [...inner, e.name]).catch(() => {})}
            title={e.name}
          >
            <span className="zip-entry-name">{e.name}</span>
            <span className="zip-entry-size">{formatSize(e.size)}</span>
          </button>
        ))}
        {!entries.length && <div className="pane-message">Empty.</div>}
      </div>
      <div className="zip-preview">
        {entry && (
          <InnerFile
            key={entry.name}
            project={project}
            path={path}
            inner={[...inner, entry.name]}
            name={entry.name.split('/').pop() ?? entry.name}
            where={within(where, entry.name) ?? ''}
          />
        )}
      </div>
    </div>
  )
}
