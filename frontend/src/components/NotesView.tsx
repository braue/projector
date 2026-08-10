import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createNote, deleteNote, listNotes, renameNote, saveNoteItems } from '../api'
import { errorMessage } from '../lib/errors'
import { useSidebarWidth } from '../lib/usePaneWidth'
import type { Note, NoteItem, NoteKind } from '../types'
import { Checkbox, InlineNameForm } from './ui'

// Notes mode — the engineer's own working notes beside the evidence. Left
// rail lists the project's notes (create / rename / delete); the pane is a
// minimalist line editor. A line is plain text, a checkbox, a bullet, or a
// numbered item:
//
//   type "[] " at the start of a line  ->  checkbox
//   type "- " (or "* ")                ->  bullet
//   type "1. " (any number)            ->  numbered
//
// Enter continues the list (a new line of the same kind); Enter on an EMPTY
// list line ends the list (back to text). Tab makes a sub-line, Shift+Tab
// brings it back out. Backspace on an empty line first drops its list style,
// then removes it. Every mutation persists the note wholesale — they're tiny.

// crypto.randomUUID needs a secure context — over plain http on a LAN it is
// undefined, and a throwing keydown handler would crash the app.
const newId = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

// "[] " / "[ ] " -> check, "- " / "* " -> bullet, "1. " / "1) " -> number.
const AUTOFORMAT: [RegExp, NoteKind][] = [
  [/^\[\s?\]\s/, 'check'],
  [/^[-*]\s/, 'bullet'],
  [/^\d+[.)]\s/, 'number'],
]

// index -> 1-based position of each numbered line within its run, one
// forward pass: same-level numbered lines count up; a sub-run restarts and
// any shallower line (or a same-level line of another kind) ends a run.
function numberRuns(items: NoteItem[]): Map<number, number> {
  const numbers = new Map<number, number>()
  const runs = [0, 0]
  items.forEach((item, index) => {
    if (item.kind === 'number') {
      runs[item.level] += 1
      numbers.set(index, runs[item.level])
    } else {
      runs[item.level] = 0
    }
    if (item.level === 0) runs[1] = 0
  })
  return numbers
}

// "2/5" over the checkbox lines; null when a note has none.
function checkCounts(note: Note): string | null {
  const checks = note.items.filter((item) => item.kind === 'check')
  if (!checks.length) return null
  return `${checks.filter((item) => item.checked).length}/${checks.length}`
}

export function NotesView({ project }: { project: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The InlineNameForm owns its value and error; these just mark which row
  // (or the create slot) is editing.
  const [naming, setNaming] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const { width, startResize } = useSidebarWidth()
  // The line a structural edit wants focused once it exists in the DOM.
  const focusId = useRef<string | null>(null)
  const inputs = useRef(new Map<string, HTMLInputElement>())
  // Unsaved text edits — blur persists only when this is set, so structural
  // saves (which blur the old input) don't double-PUT.
  const dirty = useRef(false)
  // Saves chain so rapid edits can't overlap or arrive out of order.
  const saveChain = useRef(Promise.resolve())

  const load = useCallback(async () => {
    try {
      const fetched = await listNotes(project)
      setNotes(fetched)
      setSelectedId((current) => (fetched.some((note) => note.id === current) ? current : fetched[0]?.id ?? null))
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [project])

  useEffect(() => {
    setNotes(null)
    setSelectedId(null)
    load()
  }, [load])

  useEffect(() => {
    if (!focusId.current) return
    const el = inputs.current.get(focusId.current)
    if (el) {
      el.focus()
      focusId.current = null
    }
  })

  const selected = notes?.find((note) => note.id === selectedId) ?? null
  const numbers = useMemo(() => numberRuns(selected?.items ?? []), [selected?.items])

  const setLocal = useCallback((noteId: string, items: NoteItem[]) => {
    setNotes((current) => current?.map((note) => (note.id === noteId ? { ...note, items } : note)) ?? current)
  }, [])

  // Optimistic: state first, then persist; a failed save surfaces and reloads.
  const persist = useCallback((noteId: string, items: NoteItem[]) => {
    setLocal(noteId, items)
    dirty.current = false
    saveChain.current = saveChain.current
      .then(() => saveNoteItems(project, noteId, items))
      .then(() => undefined, (err) => {
        setError(errorMessage(err))
        load()
      })
  }, [project, load, setLocal])

  const remove = async (note: Note) => {
    if (!window.confirm(`Delete note "${note.name}"?`)) return
    try {
      await deleteNote(project, note.id)
      setError(null)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  // items with one line's fields replaced.
  const patched = (items: NoteItem[], index: number, changes: Partial<NoteItem>) =>
    items.map((item, i) => (i === index ? { ...item, ...changes } : item))

  const onTextChange = (index: number, value: string) => {
    if (!selected) return
    const items = selected.items
    // A list marker typed at the start of a plain line converts it.
    if (items[index].kind === 'text') {
      for (const [pattern, kind] of AUTOFORMAT) {
        const match = value.match(pattern)
        if (match) {
          persist(selected.id, patched(items, index, { kind, text: value.slice(match[0].length) }))
          return
        }
      }
    }
    dirty.current = true
    setLocal(selected.id, patched(items, index, { text: value }))
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, index: number) => {
    if (!selected) return
    const items = selected.items
    const item = items[index]
    if (e.key === 'Enter') {
      // Enter on an empty list line ends the list; otherwise continue it.
      if (item.kind !== 'text' && item.text === '') {
        persist(selected.id, patched(items, index, { kind: 'text' }))
        return
      }
      const added: NoteItem = { id: newId(), text: '', kind: item.kind, checked: false, level: item.level }
      focusId.current = added.id
      persist(selected.id, [...items.slice(0, index + 1), added, ...items.slice(index + 1)])
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const level = e.shiftKey ? 0 : 1
      if (item.level !== level) {
        persist(selected.id, patched(items, index, { level }))
      }
    } else if (e.key === 'Backspace' && item.text === '') {
      e.preventDefault()
      // First Backspace drops the list style, the next removes the line.
      if (item.kind !== 'text') {
        persist(selected.id, patched(items, index, { kind: 'text' }))
        return
      }
      focusId.current = items[index - 1]?.id ?? null
      persist(selected.id, items.filter((_, i) => i !== index))
    }
  }

  const addLine = () => {
    if (!selected) return
    // Continue whatever the note ends with — text notes stay text.
    const last = selected.items[selected.items.length - 1]
    const added: NoteItem = {
      id: newId(),
      text: '',
      kind: last?.kind ?? 'text',
      checked: false,
      level: last?.level ?? 0,
    }
    focusId.current = added.id
    persist(selected.id, [...selected.items, added])
  }

  return (
    <>
      <aside className="sources" style={{ width }}>
        <div className="sidebar-resize" onMouseDown={startResize} title="Drag to resize" />
        <div className="source-scroll">
          {naming ? (
            <InlineNameForm
              placeholder="Note name — Enter to create"
              onCommit={async (value) => {
                const created = await createNote(project, value)
                setNaming(false)
                await load()
                setSelectedId(created.id)
              }}
              onCancel={() => setNaming(false)}
            />
          ) : (
            <button className="drop-zone as-button" onClick={() => setNaming(true)}>
              <b>New note</b>
              name it, press Enter
            </button>
          )}
          <ul className="source-list">
            {(notes ?? []).map((note) =>
              renamingId === note.id ? (
                <li key={note.id}>
                  <InlineNameForm
                    initial={note.name}
                    placeholder="New name — Enter to rename"
                    onCommit={async (value) => {
                      await renameNote(project, note.id, value)
                      setRenamingId(null)
                      await load()
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                </li>
              ) : (
                <li key={note.id}>
                  <button
                    className={note.id === selectedId ? 'project-entry status-ready selected' : 'project-entry status-ready'}
                    onClick={() => setSelectedId(note.id)}
                  >
                    <span className="project-name">{note.name}</span>
                    <span className="note-count">{checkCounts(note)}</span>
                    <span
                      className="entry-delete entry-rename"
                      title={`Rename ${note.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingId(note.id)
                      }}
                    >
                      ✎
                    </span>
                    <span
                      className="entry-delete"
                      title={`Delete ${note.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(note)
                      }}
                    >
                      ✕
                    </span>
                  </button>
                </li>
              ),
            )}
          </ul>
          {error && (
            <div className="list-error">
              <div className="list-error-text">{error}</div>
            </div>
          )}
        </div>
      </aside>

      <main className="preview">
        {selected ? (
          <>
            <header className="preview-header">
              <div className="preview-title-row">
                <h2>{selected.name}</h2>
                <span className="note-count">{checkCounts(selected)}</span>
              </div>
            </header>
            <div className="preview-scroll no-sheets">
              <div className="note-body">
                {selected.items.map((item, index) => (
                  <div
                    key={item.id}
                    className={[
                      'note-row',
                      item.level ? 'sub' : '',
                      item.kind === 'check' && item.checked ? 'done' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {item.kind === 'check' && (
                      <Checkbox
                        checked={item.checked}
                        onChange={(checked) =>
                          persist(selected.id, patched(selected.items, index, { checked }))
                        }
                      />
                    )}
                    {item.kind === 'bullet' && <span className="note-glyph">•</span>}
                    {item.kind === 'number' && (
                      <span className="note-glyph">{numbers.get(index)}.</span>
                    )}
                    <input
                      ref={(el) => {
                        if (el) inputs.current.set(item.id, el)
                        else inputs.current.delete(item.id)
                      }}
                      className="note-text"
                      value={item.text}
                      placeholder={item.kind === 'text' ? 'Write, or start a line with "[] ", "- ", "1. "' : '…'}
                      onChange={(e) => onTextChange(index, e.target.value)}
                      onBlur={() => {
                        if (dirty.current) persist(selected.id, selected.items)
                      }}
                      onKeyDown={(e) => onKeyDown(e, index)}
                    />
                  </div>
                ))}
                <button className="note-add" onClick={addLine}>+ Add line</button>
              </div>
            </div>
          </>
        ) : (
          <div className="note-empty">
            {notes === null ? 'Loading…' : 'Create a note to start writing.'}
          </div>
        )}
      </main>
    </>
  )
}
