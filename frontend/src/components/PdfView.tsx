import { useCallback, useEffect, useMemo, useState } from 'react'

import { fileRawUrl, searchPdfFile } from '../api'
import { errorMessage } from '../lib/errors'
import { useDebounced } from '../lib/useDebounced'
import type { PdfMatch } from '../types'
import { FindBar, findCount, useFindBox } from './FindBar'

// PDFs render in the preview pane with Chromium's built-in viewer (scroll,
// zoom, print) — the app and its backend share one loopback origin, so an
// <iframe> at the raw-bytes endpoint is same-origin and needs no plugin or
// dependency. Archived versions address by their real `.versions/…` path,
// which the endpoint serves like any other file.
//
// FIND (Ctrl+F) is ours, because the viewer's is not reachable: the desktop
// build has no browser find bar to lend it, and the viewer will not highlight
// a word asked for through the URL (`#search=` does nothing; only `#page=`
// lands). So the backend reads the document's text and answers with PAGES —
// each hit listed with the line it sits in — and picking one moves the
// viewer there. A page number is the actionable answer in a drawing set
// anyway; the snippet is what tells you which hit is the one you want.
//
// Moving the viewer means RELOADING it at the new fragment: Chromium reads
// `#page=` when the document loads and ignores it afterwards, so the iframe
// is keyed by page. Same page, same key, no reload — stepping through three
// hits on one page never reloads anything.

export function PdfView({
  project,
  path,
  name,
}: {
  project: string
  path: string
  name: string
}) {
  const { open, term, setTerm, inputRef, closeFind } = useFindBox()
  const [matches, setMatches] = useState<PdfMatch[]>([])
  const [total, setTotal] = useState(0)
  const [at, setAt] = useState(0)
  const [page, setPage] = useState<number | null>(null)
  const [reading, setReading] = useState(false)
  // A scanned drawing set is images of paper: there is nothing to search,
  // which is worth saying rather than answering every term with "none".
  const [textless, setTextless] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const needle = useDebounced(term.trim(), 220)

  /* Opening warms the document: reading a 600-page drawing set takes a
     moment, and it should happen while the term is still being typed rather
     than after it. The empty query is the warm — the backend caches the text
     either way, so the first real search lands on a hot document. */
  useEffect(() => {
    if (!open) return
    let live = true
    setError(null)
    searchPdfFile(project, path, '')
      .then((result) => live && setTextless(result.hasText === false))
      .catch((err) => live && setError(errorMessage(err)))
    return () => {
      live = false
    }
  }, [open, project, path])

  useEffect(() => {
    if (!open || !needle) {
      setMatches([])
      setTotal(0)
      setAt(0)
      return
    }
    let live = true
    setReading(true)
    searchPdfFile(project, path, needle)
      .then((result) => {
        if (!live) return
        setError(null)
        setTextless(result.hasText === false)
        setMatches(result.matches)
        setTotal(result.total)
        setAt(0)
        // A search lands you on its first hit, the way every find does.
        if (result.matches.length) setPage(result.matches[0].page)
      })
      .catch((err) => live && setError(errorMessage(err)))
      .finally(() => live && setReading(false))
    return () => {
      live = false
    }
  }, [open, needle, project, path])

  const goTo = useCallback(
    (index: number) => {
      if (!matches.length) return
      const next = (index + matches.length) % matches.length
      setAt(next)
      setPage(matches[next].page)
    },
    [matches],
  )

  // Same wording as every other find bar, plus the one state only this one
  // has: a document still being read.
  const count = useMemo(
    () => (needle && reading ? '…' : findCount(needle, matches.length, at)),
    [needle, reading, matches.length, at],
  )

  // Everything the viewer is told, in one string: the page rides in the
  // fragment, and the same string keys the frame, so a page change is a
  // reload and everything else is not.
  const src = `${fileRawUrl(project, path)}${page ? `#page=${page}` : ''}`

  return (
    <main className="preview pdf-view">
      <header className="preview-header">
        <div className="preview-title-row">
          <h2>{name}</h2>
        </div>
        <div className="preview-subtitle">
          <span className="mono">{path}</span>
        </div>
      </header>
      {open && (
        <FindBar
          inputRef={inputRef}
          term={term}
          onTerm={setTerm}
          count={count}
          onStep={(delta) => goTo(at + delta)}
          onClose={closeFind}
          placeholder="Find in this PDF…"
        >
          {error ? (
            <div className="find-note">{error}</div>
          ) : textless && !matches.length ? (
            <div className="find-note">
              No text in this PDF — scanned pages carry images, not words.
            </div>
          ) : needle && !reading ? (
            <>
              {total > matches.length && (
                <div className="find-note">
                  {total} matches — listing the first {matches.length}.
                </div>
              )}
              {matches.length > 0 && (
                <div className="find-hits">
                  {matches.map((hit, index) => (
                    <button
                      key={`${hit.page}:${index}`}
                      className={index === at ? 'find-hit-row on' : 'find-hit-row'}
                      onClick={() => goTo(index)}
                      title={`Go to page ${hit.page}`}
                    >
                      <span className="find-hit-page">p. {hit.page}</span>
                      <span className="find-hit-text">
                        {hit.before}
                        <mark>{hit.match}</mark>
                        {hit.after}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </FindBar>
      )}
      <div className="preview-scroll">
        <iframe
          className="pdf-frame"
          key={`${project}:${src}`}
          title={name}
          src={src}
        />
      </div>
    </main>
  )
}
