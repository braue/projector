import { useState } from 'react'

import { searchSource } from '../api'
import { errorMessage } from '../lib/errors'
import type { DeviceSource, SearchHit, SearchResults } from '../types'
import { Highlight } from './Highlight'
import { Button, TextInput } from './ui'

// Inspect › Search: every instance of a string within the SELECTED source —
// one RTAC export or one uploaded profile. Results group by the object the
// string lives in; the object header opens it in Browse, and each match
// names its exact location (setting, point row, table cell, logic line)
// with the hit highlighted.

function HitSection({
  hit,
  query,
  onOpen,
}: {
  hit: SearchHit
  query: string
  onOpen: (path: string) => void
}) {
  return (
    <section className="search-hit">
      <button className="search-hit-head" onClick={() => onOpen(hit.path)} title="Open in Browse">
        <span className="search-hit-name">{hit.name}</span>
        <span className="search-hit-kind">{hit.protocol ?? hit.kindLabel}</span>
        <span className="ui-count">{hit.matches.length}{hit.truncated ? '+' : ''}</span>
      </button>
      {hit.matches.map((match, index) => (
        <div key={index} className="search-match">
          <span className="search-where">{match.location}</span>
          <span className="search-text">
            <Highlight text={match.text} query={query} />
          </span>
        </div>
      ))}
      {hit.truncated && <div className="search-more">more matches in this object…</div>}
    </section>
  )
}

export function SearchView({
  project,
  source,
  onOpen,
}: {
  project: string
  source: DeviceSource
  /** Open a hit in Browse: select its item. */
  onOpen: (path: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    const trimmed = query.trim()
    if (!trimmed || running) return
    setRunning(true)
    setError(null)
    try {
      setResults(await searchSource(project, source, trimmed))
    } catch (err) {
      setError(errorMessage(err))
      setResults(null)
    } finally {
      setRunning(false)
    }
  }

  return (
    <main className="preview search-view">
      <header className="preview-header">
        <div className="search-bar">
          <TextInput
            autoFocus
            value={query}
            placeholder="Find a string in this source…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') run()
            }}
          />
          <Button variant="primary" disabled={!query.trim() || running} onClick={run}>
            {running ? 'Searching…' : 'Search'}
          </Button>
        </div>
        {results && (
          <div className="preview-subtitle">
            {results.totalMatches} match{results.totalMatches === 1 ? '' : 'es'} in{' '}
            {results.results.length} object{results.results.length === 1 ? '' : 's'} ·{' '}
            {results.label}
            {results.truncated && ' · showing the first objects only'}
          </div>
        )}
      </header>
      <div className="preview-scroll no-sheets">
        {error && <div className="pane-message">{error}</div>}
        {!error && results && results.results.length === 0 && (
          <div className="pane-message">No matches for "{results.query}".</div>
        )}
        {!error && !results && (
          <div className="pane-message">
            Searches everything in the selected source: names, settings, point maps, tables, and logic source.
          </div>
        )}
        {results?.results.map((hit) => (
          <HitSection key={hit.path} hit={hit} query={results.query} onOpen={onOpen} />
        ))}
      </div>
    </main>
  )
}
