import { useState } from 'react'

import { searchEverywhere } from '../api'
import { errorMessage } from '../lib/errors'
import { count } from '../lib/format'
import type { DeviceSource, EverywhereResults } from '../types'
import { Highlight } from './Highlight'
import { MatchRow, SearchHit, SearchPane } from './SearchShell'
import { Button } from './ui'

// The everywhere search: one string across EVERY project — each project's
// settings sources and notes. This answers "which job used 10.30.4.x": after
// twenty substations nobody remembers which project holds a value, and
// per-project search makes you guess the project first.
//
// Hits are pointers, not the full listing: results carry a taste of each
// source (the server caps them hard), and opening a hit jumps to that
// project's Inspect or Notes, where the complete picture lives.

/** Where a clicked hit should land: a source item in Inspect, or a note. */
export type EverywhereTarget =
  | { kind: 'source'; source: DeviceSource; path: string }
  | { kind: 'note'; id: string }

export function EverywhereSearchView({
  onOpen,
}: {
  /** Jump to a hit — switching project if the hit lives in another one. */
  onOpen: (project: string, target: EverywhereTarget) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<EverywhereResults | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  const run = async () => {
    const trimmed = query.trim()
    if (!trimmed || running) return
    setRunning(true)
    setError(null)
    try {
      setResults(await searchEverywhere(trimmed))
    } catch (err) {
      setError(errorMessage(err))
      setResults(null)
    } finally {
      setRunning(false)
    }
  }

  const totalMatches = (results?.projects ?? []).reduce(
    (sum, project) =>
      sum
      + project.sources.reduce((n, source) => n + source.totalMatches, 0)
      + project.notes.reduce((n, note) => n + note.totalMatches, 0),
    0,
  )

  const message = error
    ?? (!results
      ? 'Searches every project: all settings sources (names, settings, point maps, tables, logic) and notes. The first run may take a while — sources are parsed as they are first read.'
      : results.projects.length === 0 ? `No matches for "${results.query}" in any project.` : null)

  return (
    <SearchPane
      placeholder="Find a string in every project…"
      query={query}
      onQuery={setQuery}
      onEnter={run}
      action={
        <Button variant="primary" disabled={!query.trim() || running} onClick={run}>
          {running ? 'Searching…' : 'Search'}
        </Button>
      }
      subtitle={results && results.projects.length > 0 &&
        `${count(totalMatches, 'match', 'matches')} in ${count(results.projects.length, 'project')}`}
      message={message}
    >
      {results?.projects.map((project) => (
        <section key={project.name} className="evw-project">
          <div className="evw-project-head">{project.name}</div>
          {project.sources.map((source) => (
            <div key={`${source.type}:${source.ref}`}>
              <div className="evw-source-head">
                {source.label}
                {source.truncated && <span className="evw-more">first objects only</span>}
              </div>
              {source.results.map((hit) => (
                <SearchHit
                  key={hit.path}
                  name={hit.name}
                  meta={hit.protocol ?? hit.kindLabel}
                  count={`${hit.matches.length}${hit.truncated ? '+' : ''}`}
                  title={`Open in ${project.name} › Inspect`}
                  onOpen={() => onOpen(project.name, {
                    kind: 'source',
                    source: { type: source.type, ref: source.ref },
                    path: hit.path,
                  })}
                >
                  {hit.matches.map((match, index) => (
                    <MatchRow key={index} location={match.location}>
                      <Highlight text={match.text} query={results.query} />
                    </MatchRow>
                  ))}
                </SearchHit>
              ))}
            </div>
          ))}
          {project.notes.map((note) => (
            <SearchHit
              key={note.id}
              name={note.name}
              meta="note"
              count={`${note.matches.length}${note.truncated ? '+' : ''}`}
              title={`Open in ${project.name} › Notes`}
              onOpen={() => onOpen(project.name, { kind: 'note', id: note.id })}
            >
              {note.matches.map((match, index) => (
                <MatchRow key={index} location={match.location}>
                  <Highlight text={match.text} query={results.query} />
                </MatchRow>
              ))}
            </SearchHit>
          ))}
        </section>
      ))}
      {results && results.errors.length > 0 && (
        <div className="evw-errors">
          {results.errors.map((failure, index) => (
            <div key={index} className="evw-error">
              Could not search {failure.source ? `${failure.source} in ` : ''}{failure.project}: {failure.error}
            </div>
          ))}
        </div>
      )}
    </SearchPane>
  )
}
