import { useEffect, useMemo, useState } from 'react'

import { listNotes } from '../api'
import { errorMessage } from '../lib/errors'
import { useDebounced } from '../lib/useDebounced'
import type { Note } from '../types'
import { Highlight } from './Highlight'
import { TextInput } from './ui'

// Notes › Search: live case-insensitive substring over every note in the
// project. The notes list already carries each note's full text, so this is
// all client-side. Results group by note — name header with a match count,
// then one row per matching line — and clicking anything jumps to that note
// in Create.

interface NoteHits {
  note: Note
  lines: { number: number; text: string }[]
}

export function NotesSearchView({
  project,
  onOpen,
}: {
  project: string
  /** Jump to a note in Create. */
  onOpen: (id: string) => void
}) {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const needle = useDebounced(query, 200).trim().toLowerCase()

  useEffect(() => {
    listNotes(project).then(setNotes, (err) => setError(errorMessage(err)))
  }, [project])

  const hits = useMemo<NoteHits[]>(() => {
    if (!notes || !needle) return []
    return notes
      .map((note) => ({
        note,
        lines: note.text
          .split('\n')
          .map((text, index) => ({ number: index + 1, text }))
          .filter(({ text }) => text.toLowerCase().includes(needle)),
      }))
      .filter(({ lines }) => lines.length > 0)
  }, [notes, needle])

  const totalLines = hits.reduce((total, hit) => total + hit.lines.length, 0)

  return (
    <main className="preview search-view">
      <header className="preview-header">
        <div className="search-bar">
          <TextInput
            autoFocus
            value={query}
            placeholder="Find a string in any note…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {needle && (
          <div className="preview-subtitle">
            {totalLines} matching line{totalLines === 1 ? '' : 's'} in {hits.length}{' '}
            note{hits.length === 1 ? '' : 's'}
          </div>
        )}
      </header>
      <div className="preview-scroll no-sheets">
        {error && <div className="pane-message">{error}</div>}
        {!error && notes && !needle && (
          <div className="pane-message">
            {notes.length
              ? 'Searches every note in the project as you type.'
              : 'No notes yet — switch to Create to write one.'}
          </div>
        )}
        {!error && needle && notes && hits.length === 0 && (
          <div className="pane-message">No matches for "{query.trim()}".</div>
        )}
        {hits.map(({ note, lines }) => (
          <section key={note.id} className="search-hit">
            <button className="search-hit-head" onClick={() => onOpen(note.id)} title="Open in Create">
              <span className="search-hit-name">{note.name}</span>
              <span className="ui-count">{lines.length}</span>
            </button>
            {lines.map((line) => (
              <button
                key={line.number}
                className="search-match as-row"
                onClick={() => onOpen(note.id)}
                title="Open in Create"
              >
                <span className="search-where">line {line.number}</span>
                <span className="search-text">
                  <Highlight text={line.text} query={needle} />
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </main>
  )
}
