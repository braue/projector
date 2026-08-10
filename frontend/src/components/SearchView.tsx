import { useState } from 'react'

import { searchProject } from '../api'
import { errorMessage } from '../lib/errors'
import type { DeviceSource, SearchHit, SearchResults, SearchSource } from '../types'
import { Button, TextInput } from './ui'

// Inspect › Search: every instance of a string ANYWHERE in the project —
// all RTAC exports and every uploaded profile at once. Results group by
// source, then by the object the string lives in; the object header opens
// it in Browse, and each match names its exact location (setting, point
// row, table cell, logic line) with the hit highlighted.

function Highlight({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

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

function SourceSection({
  source,
  query,
  onOpen,
}: {
  source: SearchSource
  query: string
  onOpen: (target: DeviceSource, path: string) => void
}) {
  const count = source.results.reduce((total, hit) => total + hit.matches.length, 0)
  return (
    <section className="search-source">
      <div className="search-source-head">
        <span className="search-source-label">{source.label}</span>
        <span className="relay-type">{source.type.toUpperCase()}</span>
        <span className="ui-count">{count}</span>
      </div>
      {source.results.map((hit) => (
        <HitSection
          key={hit.path}
          hit={hit}
          query={query}
          onOpen={(path) => onOpen({ type: source.type, ref: source.ref }, path)}
        />
      ))}
    </section>
  )
}

export function SearchView({
  project,
  onOpen,
}: {
  project: string
  /** Open a hit in Browse: select its source and item. */
  onOpen: (source: DeviceSource, path: string) => void
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
      setResults(await searchProject(project, trimmed))
    } catch (err) {
      setError(errorMessage(err))
      setResults(null)
    } finally {
      setRunning(false)
    }
  }

  const objectCount = results?.sources.reduce((total, source) => total + source.results.length, 0) ?? 0

  return (
    <main className="preview search-view">
      <header className="preview-header">
        <div className="search-bar">
          <TextInput
            autoFocus
            value={query}
            placeholder="Find a string anywhere in this project…"
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
            {results.totalMatches} match{results.totalMatches === 1 ? '' : 'es'} in {objectCount}{' '}
            object{objectCount === 1 ? '' : 's'} across {results.sources.length}{' '}
            source{results.sources.length === 1 ? '' : 's'}
            {results.truncated && ' · showing the first objects only'}
          </div>
        )}
      </header>
      <div className="preview-scroll no-sheets">
        {error && <div className="pane-message">{error}</div>}
        {!error && results && results.sources.length === 0 && (
          <div className="pane-message">No matches for "{results.query}".</div>
        )}
        {!error && !results && (
          <div className="pane-message">
            Searches every source in the project: names, settings, point maps, tables, and logic source.
          </div>
        )}
        {results?.sources.map((source) => (
          <SourceSection
            key={`${source.type}:${source.ref}`}
            source={source}
            query={results.query}
            onOpen={onOpen}
          />
        ))}
      </div>
    </main>
  )
}
