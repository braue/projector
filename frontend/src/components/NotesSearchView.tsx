import { useMemo } from 'react'

import { listNotes } from '../api'
import { count } from '../lib/format'
import { useFetch } from '../lib/useFetch'
import { useSearchQuery } from '../lib/useSearchQuery'
import type { Note } from '../types'
import { Highlight } from './Highlight'
import { MatchRow, SearchHit, SearchPane } from './SearchShell'

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
  const { data: notes, error } = useFetch(() => listNotes(project), [project])
  const { query, setQuery, needle } = useSearchQuery()

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

  const message = error
    ?? (!needle
      ? notes && !notes.length
        ? 'No notes yet — switch to Create to write one.'
        : 'Searches every note in the project as you type.'
      : notes && hits.length === 0 ? `No matches for "${query.trim()}".` : null)

  return (
    <SearchPane
      placeholder="Find a string in any note…"
      query={query}
      onQuery={setQuery}
      subtitle={needle && `${count(totalLines, 'matching line')} in ${count(hits.length, 'note')}`}
      message={message}
    >
      {hits.map(({ note, lines }) => (
        <SearchHit
          key={note.id}
          name={note.name}
          count={lines.length}
          title="Open in Create"
          onOpen={() => onOpen(note.id)}
        >
          {lines.map((line) => (
            <MatchRow
              key={line.number}
              location={`line ${line.number}`}
              title="Open in Create"
              onClick={() => onOpen(note.id)}
            >
              <Highlight text={line.text} query={needle} />
            </MatchRow>
          ))}
        </SearchHit>
      ))}
    </SearchPane>
  )
}
