import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'

import {
  CATEGORIES,
  DOCS,
  PATHS,
  TASKS,
  breadcrumb,
  docById,
  docsInCategory,
  docsInReadingOrder,
  extraCategories,
  groupLabel,
} from '../atlas/content'
import type { Doc } from '../atlas/content'
import { search, highlightParts } from '../atlas/search'
import { selOpen, selStatus, selText } from '../atlas/selDocs'
import type { SelStatus, SelTextGroup } from '../atlas/selDocs'
import { useDebounced } from '../lib/useDebounced'
import { TabBar } from './ui'
import '../atlas/atlas.css'

// Atlas mode — the field-knowledge library (Desktop/atlas/content), embedded
// whole: category rail with search on the left, the document on the right,
// with an "On this page" section rail. HTML field guides render in a
// sandboxed-by-srcDoc iframe and get DOC_SKIN injected at render time
// (screen-only, so the pages' own print styles survive). DOC_SKIN restyles
// them in projector's palette — the iframe is a separate document, so the
// tokens are mirrored into it rather than inherited.
// The skin also carries a click handler that turns `atlas:<doc id>` links
// inside a page into a navigation message for this shell.

/* The iframe is a separate document, so projector's tokens cannot cascade in.
   The VALUES have to be restated inside the frame — but they are read off the
   parent at render time rather than copied here, so the two can never drift.
   Adding a token to the skin means adding its name to this list. */
const SKIN_TOKENS = [
  'card', 'bg', 'ink', 'muted', 'border', 'border-soft', 'fill',
  'accent', 'accent-tint', 'bad', 'bad-tint', 'warn', 'warn-tint', 'font-mono',
]

type HomeTab = 'paths' | 'browse'

function skinTokens(): string {
  const root = getComputedStyle(document.documentElement)
  const values = SKIN_TOKENS.map((n) => `--${n}: ${root.getPropertyValue(`--${n}`).trim()};`)
  return `:root { ${values.join(' ')} }`
}

const DOC_SKIN = `<style id="atlas-skin">@media screen {
  html { scroll-behavior: smooth; }
  body {
    font-family: ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 14.5px; line-height: 1.7; color: var(--ink); background: var(--card);
    max-width: 800px; margin: 0 auto; padding: 40px 40px 110px;
    -webkit-font-smoothing: antialiased;
  }
  .masthead { background: transparent; border: 0; border-radius: 0; padding: 0 0 22px; margin-bottom: 26px; border-bottom: 1px solid var(--border); }
  .masthead h1 { font-size: 26px; font-weight: 650; letter-spacing: 0; color: var(--ink); margin-bottom: 8px; }
  .masthead p { color: var(--muted); font-size: 14px; line-height: 1.65; margin-bottom: 14px; }
  .chips span {
    border: 1px solid var(--border); background: var(--fill); color: var(--muted);
    border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600; margin-right: 5px;
  }
  h2 {
    font-size: 18px; font-weight: 650; color: var(--ink);
    margin: 36px 0 12px; padding-top: 22px; border-top: 1px solid var(--border);
  }
  h2 .num {
    background: transparent; color: var(--accent); width: auto; height: auto;
    font-size: 13px; font-weight: 700; border-radius: 0;
  }
  h2 .num::after { content: '.'; }
  h3 { font-size: 15px; font-weight: 650; color: var(--ink); margin: 22px 0 7px; }
  h4 { font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--muted); margin: 18px 0 6px; }
  p { margin-bottom: 11px; }
  ul, ol { margin: 0 0 11px 22px; }
  li { margin-bottom: 5px; }
  strong { color: var(--ink); font-weight: 650; }
  code {
    background: var(--fill); border: 1px solid var(--border); border-radius: 5px;
    padding: 1px 5px; font-family: var(--font-mono); font-size: 0.88em;
  }
  pre { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; font-family: var(--font-mono); font-size: 12px; }
  pre code { background: none; border: 0; padding: 0; font-size: inherit; }
  table { font-size: 13px; margin: 12px 0 18px; }
  th {
    font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--muted);
    border-bottom: 1px solid var(--border); padding: 7px 12px 7px 0;
  }
  td { border-bottom: 1px solid var(--border-soft); padding: 7px 12px 7px 0; }
  .card {
    border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px;
    padding: 13px 17px; background: var(--card); margin-bottom: 12px;
  }
  /* A callout is neutral; .warn and .keyfact are the same block carrying the
     amber and red tones. They must keep their own left border and tint — the
     skin used to flatten all three to accent-green on grey, which threw the
     signal away. */
  .callout, .warn, .keyfact {
    background: var(--fill); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; padding: 11px 16px; margin: 14px 0;
  }
  .warn { background: var(--warn-tint); border-color: var(--border); border-left-color: var(--warn); }
  .keyfact { background: var(--bad-tint); border-color: var(--border); border-left-color: var(--bad); }
  .grid3 > div { border: 1px solid var(--border); border-radius: 8px; padding: 12px 15px; }
  .fig { border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin: 18px 0; background: var(--card); }
  .figcap { font-size: 12px; color: var(--muted); margin-top: 8px; line-height: 1.55; }
  .footnote {
    font-size: 12.5px; color: var(--muted); border-top: 1px solid var(--border);
    margin-top: 40px; padding-top: 18px; line-height: 1.65;
  }
  .seealso { border-top: 1px solid var(--border); margin-top: 36px; padding-top: 20px; }
  .seealso b { font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: none; color: var(--muted); margin-bottom: 10px; }
  .seealso a {
    border: 1px solid var(--border); background: var(--card); border-radius: 999px;
    padding: 5px 14px; font-size: 13px; margin: 0 6px 8px 0;
  }
  .seealso a:hover { background: var(--fill); text-decoration: none; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
}</style>
<script>
document.addEventListener('click', function (e) {
  var el = e.target
  while (el && el.nodeName !== 'A') el = el.parentElement
  if (!el) return
  var href = el.getAttribute('href') || ''
  if (href.slice(0, 6) === 'atlas:') {
    e.preventDefault()
    parent.postMessage({ atlasNavigate: href.slice(6) }, '*')
  }
})
</script>`

function injectSkin(raw: string): string {
  const skin = `<style id="atlas-tokens">@media screen { ${skinTokens()} }</style>${DOC_SKIN}`
  const i = raw.search(/<\/head>/i)
  if (i >= 0) return raw.slice(0, i) + skin + raw.slice(i)
  return skin + raw
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/** `active` is false while the atlas is mounted but hidden behind the project:
 *  it keeps the reading position alive without letting the view swallow the
 *  keyboard shortcuts meant for the pane you can actually see. */
export function AtlasView({ active = true }: { active?: boolean }) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set(['start-here']))
  // null until the first search asks. Stays null when there is no backend at
  // all (the standalone atlas), which is how the SEL section stays silently
  // absent there rather than erroring.
  const [selLib, setSelLib] = useState<SelStatus | null>(null)
  // Page hits from inside the SEL PDFs, grouped by document type.
  const [textGroups, setTextGroups] = useState<SelTextGroup[]>([])
  const searchRef = useRef<HTMLInputElement>(null)

  const selected = useMemo(() => (selectedId ? docById(selectedId) : null), [selectedId])
  // The index ships with the app, so search always works; the PDF library is
  // optional and only gates whether a hit can auto-open the document.
  // Optimistic until status answers, so the affordance does not flicker.
  const canOpenPdfs = selLib?.rootPresent ?? true
  const debounced = useDebounced(query.trim(), 180)
  const hits = useMemo(() => (debounced ? search(debounced) : []), [debounced])
  const allCategories = useMemo(() => [...CATEGORIES, ...extraCategories()], [])
  const reading = useMemo(() => docsInReadingOrder(), [])

  /* Selecting a doc reveals it in the rail. */
  const go = useCallback((id: string) => {
    const doc = docById(id)
    if (!doc) return
    setSelectedId(id)
    setOpen((prev) => (prev.has(doc.category) ? prev : new Set(prev).add(doc.category)))
  }, [])

  /* Full text of the SEL PDFs — the same words you just searched the guides
     for, run against 124,000 pages of manuals. Short queries are skipped: two
     characters match most of the corpus and the round trip is wasted. */
  useEffect(() => {
    selStatus().then(setSelLib, () => {})
  }, [])

  useEffect(() => {
    if (debounced.length < 3) {
      setTextGroups([])
      return
    }
    let live = true
    selText(debounced)
      .then((result) => live && setTextGroups(result.groups ?? []))
      .catch(() => live && setTextGroups([]))
    return () => {
      live = false
    }
  }, [debounced])

  /* Cross-doc links from inside the embedded pages. */
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const id = (e.data as { atlasNavigate?: string } | null)?.atlasNavigate
      if (typeof id === 'string') go(id)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [go])

  useEffect(() => {
    if (!active) return
    function onKey(e: KeyboardEvent) {
      if (e.key === '/' && !isEditable(e.target)) {
        e.preventDefault()
        searchRef.current?.focus()
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('')
        searchRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  function toggleCategory(id: string) {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allOpen = open.size >= allCategories.length
  const idx = selected ? reading.findIndex((d) => d.id === selected.id) : -1
  const prev = idx > 0 ? reading[idx - 1] : null
  const next = idx >= 0 && idx < reading.length - 1 ? reading[idx + 1] : null

  return (
    <>
      <aside className="atl-sidebar">
        <div className="atl-sidebar-head">
          <input
            ref={searchRef}
            className="ui-input atl-search"
            placeholder="Search docs…  ( / )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="atl-sidebar-body">
          {query.trim() ? (
            <div>
              <div className="atl-section atl-section-atlas">
                <div className="atl-section-head">
                  <span className="atl-section-title">Atlas guides</span>
                  <span className="ui-count atl-section-count">{hits.length || 'none'}</span>
                </div>
                <div className="atl-section-sub">Written for you, opens here</div>
              </div>
              {hits.map((h) => (
                <button
                  key={h.doc.id}
                  className={`atl-result ${h.doc.id === selectedId ? 'selected' : ''}`}
                  onClick={() => go(h.doc.id)}
                >
                  <div className="atl-result-top">
                    <span className="atl-result-title">{h.doc.title}</span>
                    <span className="atl-result-cat">{breadcrumb(h.doc)}</span>
                  </div>
                  <Snippet text={h.snippet} query={debounced} />
                </button>
              ))}

              {selLib && !selLib.fullText.available && query.trim().length > 2 && (
                <div className="atl-sel-block">
                  <div className="atl-section atl-section-sel">
                    <div className="atl-section-head">
                      <span className="atl-section-title">SEL documents</span>
                    </div>
                  </div>
                  <div className="atl-sel-note">
                    No full-text index is available in this build.
                  </div>
                </div>
              )}
              {textGroups.length > 0 && (
                <div className="atl-sel-block">
                  <div className="atl-section atl-section-sel">
                    <div className="atl-section-head">
                      <span className="atl-section-title">SEL documents</span>
                      <span className="ui-count atl-section-count">
                        {textGroups.reduce((n, g) => n + g.hits.length, 0)} pages
                      </span>
                    </div>
                    <div className="atl-section-sub">
                      {canOpenPdfs
                        ? <>Source PDFs &mdash; opens in your PDF viewer</>
                        : <>Source PDFs &mdash; library not on this machine, hits won&apos;t open</>}
                    </div>
                  </div>
                  {/* One section per document type, best-matching type first,
                      so manuals cannot bury the application guides. */}
                  {textGroups.map((group) => (
                    <div key={group.folder} className="atl-sel-group">
                      <div className="atl-sel-group-head">
                        {group.label}
                        <span className="atl-sel-note-inline">{group.hits.length}</span>
                      </div>
                      {group.hits.map((hit) => (
                        <button
                          key={`${hit.path}#${hit.page}`}
                          className="atl-result atl-text-hit"
                          onClick={canOpenPdfs
                            ? () => selOpen(hit.path, hit.page).catch(() => {})
                            : undefined}
                          title={canOpenPdfs
                            ? `Open ${hit.name} at page ${hit.page}`
                            : `${hit.name} p.${hit.page} — the PDF is not on this machine`}
                        >
                          <div className="atl-result-top">
                            <span className="atl-result-title">{hit.name}</span>
                            <span className="atl-result-cat">
                              p.{hit.page}{canOpenPdfs && <> <span className="atl-ext">&#8599;</span></>}
                            </span>
                          </div>
                          <Snippet text={hit.snippet} query={debounced} />
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <button
                className="atl-expand-all"
                onClick={() =>
                  setOpen(allOpen ? new Set() : new Set(allCategories.map((c) => c.id)))
                }
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
              <button className="atl-home-link" onClick={() => setSelectedId(null)}>
                Home
              </button>
              {allCategories.map((cat) => {
                const docs = docsInCategory(cat.id)
                const isOpen = open.has(cat.id)
                return (
                  <div key={cat.id} className="atl-cat">
                    <button className="atl-cat-head" onClick={() => toggleCategory(cat.id)}>
                      <span className={`atl-chev ${isOpen ? 'open' : ''}`}>▸</span>
                      <span className="atl-cat-label">{cat.label}</span>
                      <span className="ui-count">{docs.length || ''}</span>
                    </button>
                    {isOpen && (
                      <div className="atl-cat-docs">
                        {docs
                          .filter((d) => !d.group)
                          .map((d) => (
                            <AtlasDocRow key={d.id} doc={d} selectedId={selectedId} onSelect={go} />
                          ))}
                        {[...new Set(docs.flatMap((d) => (d.group ? [d.group] : [])))].map((g) => (
                          <div key={g}>
                            <div className="atl-subcat-head">{groupLabel(g)}</div>
                            {docs
                              .filter((d) => d.group === g)
                              .map((d) => (
                                <AtlasDocRow
                                  key={d.id}
                                  doc={d}
                                  selectedId={selectedId}
                                  onSelect={go}
                                  indent
                                />
                              ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}
        </div>
      </aside>

      <main className="atl-content">
        {selected ? (
          <AtlasDocView doc={selected} prev={prev} next={next} onSelect={go} />
        ) : (
          <AtlasHome onSelect={go} />
        )}
      </main>
    </>
  )
}

function Snippet({ text, query }: { text: string; query: string }) {
  return (
    <div className="atl-result-snippet">
      {highlightParts(text, query).map((p, i) =>
        p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
      )}
    </div>
  )
}

function AtlasDocRow(props: {
  doc: Doc
  selectedId: string | null
  onSelect: (id: string) => void
  indent?: boolean
}) {
  const { doc, selectedId, onSelect, indent } = props
  return (
    <button
      className={`atl-doc-row ${doc.id === selectedId ? 'selected' : ''} ${indent ? 'indent' : ''}`}
      onClick={() => onSelect(doc.id)}
      title={doc.summary}
    >
      <span className="atl-doc-title">{doc.title}</span>
    </button>
  )
}

interface Heading {
  text: string
  el: Element
}

function headingText(el: Element): string {
  return (el.textContent ?? '').replace(/^\d+\.?\s*/, '').trim()
}

function OnThisPage({ headings }: { headings: Heading[] }) {
  if (headings.length < 2) return null
  return (
    <nav className="atl-toc">
      <div className="atl-toc-label">On this page</div>
      {headings.map((h, i) => (
        <button
          key={i}
          className="atl-toc-item"
          onClick={() => h.el.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          {h.text}
        </button>
      ))}
    </nav>
  )
}

function PrevNext(props: { prev: Doc | null; next: Doc | null; onSelect: (id: string) => void }) {
  const { prev, next, onSelect } = props
  if (!prev && !next) return null
  return (
    <div className="atl-prevnext">
      {prev ? (
        <button className="atl-pn" onClick={() => onSelect(prev.id)}>
          <span className="atl-pn-dir">← Previous</span>
          <span className="atl-pn-title">{prev.title}</span>
        </button>
      ) : (
        <span />
      )}
      {next && (
        <button className="atl-pn right" onClick={() => onSelect(next.id)}>
          <span className="atl-pn-dir">Next →</span>
          <span className="atl-pn-title">{next.title}</span>
        </button>
      )}
    </div>
  )
}

function AtlasDocView(props: {
  doc: Doc
  prev: Doc | null
  next: Doc | null
  onSelect: (id: string) => void
}) {
  const { doc, prev, next, onSelect } = props
  const [headings, setHeadings] = useState<Heading[]>([])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const articleRef = useRef<HTMLElement>(null)
  const html = useMemo(
    () => (doc.kind === 'md' ? (marked.parse(doc.raw) as string) : ''),
    [doc.kind, doc.raw],
  )
  const srcDoc = useMemo(() => (doc.kind === 'html' ? injectSkin(doc.raw) : ''), [doc.kind, doc.raw])

  useEffect(() => {
    setHeadings([])
    if (doc.kind !== 'md') return
    const a = articleRef.current
    if (!a) return
    setHeadings([...a.querySelectorAll('h2')].map((el) => ({ text: headingText(el), el })))
  }, [doc.id, doc.kind, html])

  function collectFrameHeadings() {
    const d = frameRef.current?.contentDocument
    if (!d) return
    setHeadings([...d.querySelectorAll('h2')].map((el) => ({ text: headingText(el), el })))
  }

  /* atlas: links inside rendered markdown */
  function onArticleClick(e: React.MouseEvent) {
    let el = e.target as HTMLElement | null
    while (el && el.nodeName !== 'A') el = el.parentElement
    const href = el?.getAttribute('href') ?? ''
    if (href.startsWith('atlas:')) {
      e.preventDefault()
      onSelect(href.slice(6))
    }
  }

  return (
    <div className="atl-docview">
      <div className="atl-docbar">
        <span className="atl-docbar-cat">{breadcrumb(doc)}</span>
        <span className="atl-docbar-title">{doc.title}</span>
      </div>
      <div className="atl-doc-body">
        <div className="atl-doc-scroll">
          {doc.kind === 'html' ? (
            <iframe
              ref={frameRef}
              className="atl-doc-frame"
              title={doc.title}
              srcDoc={srcDoc}
              onLoad={collectFrameHeadings}
            />
          ) : (
            <article
              className="atl-prose"
              ref={articleRef}
              onClick={onArticleClick}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
          <PrevNext prev={prev} next={next} onSelect={onSelect} />
        </div>
        <OnThisPage headings={headings} />
      </div>
    </div>
  )
}

function AtlasHome({ onSelect }: { onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<HomeTab>('paths')
  return (
    <div className="atl-home">
      <div className="atl-home-head">
        <h1>Atlas</h1>
        <p className="atl-dim">
          The field-knowledge library — {DOCS.length} documents on power system fundamentals,
          protection, communications, protocols, and the RTAC, each grounded in the SEL reference
          library. Press <kbd>/</kbd> to search titles, tags, and full text.
        </p>
      </div>

      <TabBar
        tabs={[
          { key: 'paths', label: 'Where to start' },
          { key: 'browse', label: 'Browse everything' },
        ]}
        activeKey={tab}
        onSelect={(key) => setTab(key as HomeTab)}
      />

      {tab === 'paths' ? (
        <>
          <section className="atl-home-section">
            <h2>I need to…</h2>
            <div className="atl-task-grid">
              {TASKS.map((t) => (
                <button key={t.q} className="atl-task" onClick={() => onSelect(t.doc)}>
                  <span className="atl-task-q">{t.q}</span>
                  <span className="atl-task-doc">{docById(t.doc)?.title ?? t.doc}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="atl-home-section">
            <h2>Reading paths</h2>
            <div className="atl-path-grid">
              {PATHS.map((p) => (
                <div key={p.label} className="atl-path">
                  <div className="atl-path-label">{p.label}</div>
                  <div className="atl-path-blurb atl-dim">{p.blurb}</div>
                  <ol className="atl-path-docs">
                    {p.docs.map((id) => {
                      const d = docById(id)
                      return (
                        <li key={id}>
                          <button onClick={() => onSelect(id)} disabled={!d}>
                            {d?.title ?? id}
                          </button>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        <section className="atl-home-section">
          {CATEGORIES.map((c) => {
            const docs = docsInCategory(c.id)
            if (docs.length === 0) return null
            return (
              <div key={c.id} className="atl-browse-cat">
                <div className="atl-browse-head">
                  <span className="atl-browse-label">{c.label}</span>
                  <span className="atl-browse-hint atl-dim">{c.hint}</span>
                </div>
                <div className="atl-browse-docs">
                  {docs.map((d) => (
                    <button key={d.id} className="atl-browse-doc" onClick={() => onSelect(d.id)}>
                      <span className="atl-bd-title">{d.title}</span>
                      <span className="atl-bd-summary atl-dim">{d.summary}</span>
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}
