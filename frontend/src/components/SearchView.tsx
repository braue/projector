import { useState } from 'react'

import { searchArtifact } from '../api'
import { errorMessage } from '../lib/errors'
import { count } from '../lib/format'
import type { SearchResults } from '../types'
import { Highlight } from './Highlight'
import { MatchRow, SearchHit, SearchPane } from './SearchShell'
import { Button } from './ui'

// Inspect › Search: every instance of a string within the SELECTED artifact
// (or one profile of it). Results group by the object the
// string lives in; the object header opens it in Browse, and each match
// names its exact location (setting, point row, table cell, logic line)
// with the hit highlighted.

export function SearchView({
  project,
  refId,
  onOpen,
}: {
  project: string
  /** The artifact ref being searched ("<path>" or "<path>::<profile>"). */
  refId: string
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
      setResults(await searchArtifact(project, refId, trimmed))
    } catch (err) {
      setError(errorMessage(err))
      setResults(null)
    } finally {
      setRunning(false)
    }
  }

  const message = error
    ?? (results && results.results.length === 0 ? `No matches for "${results.query}".` : null)

  return (
    <SearchPane
      placeholder="Find a string in this artifact…"
      query={query}
      onQuery={setQuery}
      onEnter={run}
      action={
        <Button variant="primary" disabled={!query.trim() || running} onClick={run}>
          {running ? 'Searching…' : 'Search'}
        </Button>
      }
      subtitle={results &&
        `${count(results.totalMatches, 'match', 'matches')} in ${count(results.results.length, 'object')} · ${results.label}${results.truncated ? ' · showing the first objects only' : ''}`}
      message={message}
    >
      {results?.results.map((hit) => (
        <SearchHit
          key={hit.path}
          name={hit.name}
          meta={hit.protocol ?? hit.kindLabel}
          count={`${hit.matches.length}${hit.truncated ? '+' : ''}`}
          title="Open in Browse"
          onOpen={() => onOpen(hit.path)}
        >
          {hit.matches.map((match, index) => (
            <MatchRow key={index} location={match.location}>
              <Highlight text={match.text} query={results.query} />
            </MatchRow>
          ))}
          {hit.truncated && <div className="search-more">more matches in this object…</div>}
        </SearchHit>
      ))}
    </SearchPane>
  )
}
